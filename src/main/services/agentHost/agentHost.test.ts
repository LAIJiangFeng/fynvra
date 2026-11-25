import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import {
  BUILTIN_ROLES,
  getBuiltinRole,
  JsonFileRoleStore,
  type Role,
  type ThinkingLevel,
} from '@fynvra/core';
import type {
  AgentApprovalRequest,
  AgentCommand,
  ModelQuery,
  SpawnSessionSpec,
} from '@shared/types/agent';
import type {
  ApprovalDecision,
  ChatImage,
  ModelThinkingCapability,
  SessionEventEnvelope,
  SessionModelRef,
} from '@shared/types/chat';
import { appendChatFiles } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMainLocale } from '../../i18n';
import { createOrchestrationRegistry } from '../orchestration/registry';
import { createFakeExec, createFakeRoles } from '../orchestration/testing';
import { type StoredProvider, toProviderView } from '../providers/providerStore';
import { createModelResolver, runtimeProviderId } from '../providers/resolveModel';
import { BRANCH_REFRESH_THROTTLE_MS, createBranchTracker } from '../sessions/branches';
import * as historyProjection from '../sessions/history';
import { sessionFilePath } from '../sessions/history';
import { createSessionStore } from '../sessions/sessionStore';
import { type AgentHostDeps, createAgentHost, titleFrom } from './agentHost';
import { connectOrchestration } from './connectOrchestration';
import type { WorkerProcess } from './workerClient';

describe('context runtime snapshots and recovery', () => {
  it('ACKs unloaded recovery before resource loading, and Stop prevents a late spawn', async () => {
    const resources = Promise.withResolvers<{
      skills: string[];
      mcpServers: [];
      warnings: string[];
    }>();
    const env = setup({ resolveResources: () => resources.promise });
    const session = await createSession(env);
    expect(await env.host.retryCompaction(session.id)).toEqual({ ok: true });
    expect(env.host.get(session.id)?.contextRuntime).toBeUndefined();
    expect(await env.host.retryCompaction(session.id)).toMatchObject({ ok: false });
    expect(await env.host.prompt(session.id, 'must remain unsent')).toMatchObject({ ok: false });
    expect(await env.host.abort(session.id)).toEqual({ ok: true });
    resources.resolve({ skills: [], mcpServers: [], warnings: [] });
    await flush();
    await flush();
    expect(env.sent('spawn-session')).toHaveLength(0);
    expect(env.sent('retry-compaction')).toHaveLength(0);
    expect(env.host.get(session.id)).toMatchObject({ status: 'idle' });
    expect(env.host.get(session.id)?.contextRuntime).toBeUndefined();
  });

  it('prefers new live runtime over a delayed cold checkpoint read', async () => {
    const env = setup();
    const session = await createSession(env);
    const disk = Promise.withResolvers<historyProjection.HistoryProjection>();
    const read = vi
      .spyOn(historyProjection, 'readHistoryProjection')
      .mockReturnValueOnce(disk.promise);
    try {
      const response = env.host.history(session.id);
      await env.host.prompt(session.id, 'new live input');
      const snapshot = {
        configuredStrategy: 'native',
        effectiveStrategy: 'native',
        compactionTimeoutMs: 600000,
        context: { tokens: null, contextWindow: 100000, source: 'unknown' },
        recoveryRequired: false,
        pendingPromptCount: 0,
      } as const;
      env.worker().emit({
        type: 'session-event',
        identity: { sessionId: session.id, generation: 1 },
        seq: 1,
        event: { type: 'context_runtime', snapshot, seq: 1 },
      });
      disk.resolve(
        historyProjection.projectHistoryProjection(
          JSON.stringify({
            type: 'custom',
            id: 'checkpoint',
            parentId: null,
            customType: 'fynvra-context-recovery',
            data: { blocked: true, pending: [] },
          }),
          session.id
        )
      );
      const result = await response;
      expect(result).toMatchObject({ ok: true, contextRuntime: snapshot, contextRuntimeSeq: 1 });
      expect(result).not.toHaveProperty('contextRecovery');
    } finally {
      read.mockRestore();
    }
  });

  it('keeps the pre-read watermark and drops the cold hint when newer live facts arrive without a runtime snapshot', async () => {
    const env = setup();
    const session = await createSession(env);
    const disk = Promise.withResolvers<historyProjection.HistoryProjection>();
    const read = vi
      .spyOn(historyProjection, 'readHistoryProjection')
      .mockReturnValueOnce(disk.promise);
    try {
      const response = env.host.history(session.id);
      await env.host.prompt(session.id, 'new attempt');
      env.worker().emit({
        type: 'session-error',
        identity: { sessionId: session.id, generation: 1 },
        fatal: true,
        error: 'new loading failure',
      });
      expect(env.events(session.id).at(-1)?.seq).toBeGreaterThan(0);
      disk.resolve(
        historyProjection.projectHistoryProjection(
          JSON.stringify({
            type: 'custom',
            id: 'checkpoint',
            parentId: null,
            customType: 'fynvra-context-recovery',
            data: { blocked: false, pending: [] },
          }),
          session.id
        )
      );
      expect(await response).toEqual({ ok: true, messages: [], contextRuntimeSeq: 0 });
    } finally {
      read.mockRestore();
    }
  });

  it('does not advertise a disk recovery hint while an explicit recovery is still loading', async () => {
    const resources = Promise.withResolvers<{
      skills: string[];
      mcpServers: [];
      warnings: string[];
    }>();
    const env = setup({ resolveResources: () => resources.promise });
    const session = await createSession(env);
    mkdirSync(join(env.dir, 'agent', 'sessions'), { recursive: true });
    writeFileSync(
      sessionFilePath(join(env.dir, 'agent'), session.id),
      JSON.stringify({
        type: 'custom',
        id: 'checkpoint',
        parentId: null,
        customType: 'fynvra-context-recovery',
        data: { blocked: true, pending: [] },
      })
    );
    expect(await env.host.retryCompaction(session.id)).toEqual({ ok: true });
    expect(await env.host.history(session.id)).toEqual({
      ok: true,
      messages: [],
      contextRuntimeSeq: 0,
    });
    await env.host.abort(session.id);
    resources.resolve({ skills: [], mcpServers: [], warnings: [] });
    await flush();
    expect(await env.host.history(session.id)).toMatchObject({
      ok: true,
      contextRuntimeSeq: 0,
      contextRecovery: { recoveryRequired: true },
    });
  });

  it('holds the recovery mutex until the matching worker result, even across intermediate idle status', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.retryCompaction(session.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(env.sent('retry-compaction')).toHaveLength(1));
    const command = env.sent('retry-compaction')[0];
    if (command?.type !== 'retry-compaction') throw new Error('missing recovery command');
    env.worker().emit({ type: 'session-status', identity: command.identity, status: 'idle' });
    env.worker().emit({
      type: 'compaction-recovery-result',
      identity: command.identity,
      requestId: 'stale',
      result: { ok: true },
    });
    expect(await env.host.retryCompaction(session.id)).toMatchObject({ ok: false });
    env.worker().emit({
      type: 'compaction-recovery-result',
      identity: command.identity,
      requestId: command.requestId,
      result: { ok: false, error: 'No compaction recovery is required.' },
    });
    expect(env.host.get(session.id)?.status).toBe('error');
    expect(env.events(session.id).at(-1)).toMatchObject({
      type: 'error',
      source: 'compaction',
      message: 'No compaction recovery is required.',
    });
    expect(env.sent('prompt')).toHaveLength(0);
  });

  it('compacts an idle session on demand: loads it first, ACKs, and settles on the result', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.compact(session.id)).toEqual({ ok: true });
    expect(env.host.get(session.id)?.status).toBe('running');
    // Mutual exclusion while the operation is in flight.
    expect(await env.host.compact(session.id)).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(env.sent('compact')).toHaveLength(1));
    expect(env.sent('spawn-session')).toHaveLength(1);
    expect(env.sent('retry-compaction')).toHaveLength(0);
    const command = env.sent('compact')[0];
    if (command?.type !== 'compact') throw new Error('missing compact command');
    env.worker().emit({
      type: 'compaction-recovery-result',
      identity: command.identity,
      requestId: command.requestId,
      result: { ok: true },
    });
    expect(env.host.get(session.id)?.status).toBe('idle');
    // Already loaded: the next compaction does not spawn again.
    expect(await env.host.compact(session.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(env.sent('compact')).toHaveLength(2));
    expect(env.sent('spawn-session')).toHaveLength(1);
  });

  it('takes back queued inputs: empty before spawn, settles on the matching result, fails on timeout', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.takeBackQueued(session.id)).toEqual({ ok: true, texts: [] });
    expect(env.sent('take-back-queued')).toHaveLength(0);
    expect(await env.host.takeBackQueued('missing')).toMatchObject({ ok: false });
    expect(await env.host.prompt(session.id, 'work')).toEqual({ ok: true });
    await vi.waitFor(() => expect(env.sent('spawn-session')).toHaveLength(1));
    const pending = env.host.takeBackQueued(session.id);
    const command = env.sent('take-back-queued')[0];
    if (command?.type !== 'take-back-queued') throw new Error('missing take-back command');
    // 过期 generation 与不匹配的 requestId 都被丢弃
    for (const stale of [
      { identity: { ...command.identity, generation: 0 }, requestId: command.requestId },
      { identity: command.identity, requestId: 'stale' },
    ]) {
      env.worker().emit({ type: 'queue-taken-back', ...stale, result: { ok: true, texts: ['x'] } });
    }
    env.worker().emit({
      type: 'queue-taken-back',
      identity: command.identity,
      requestId: command.requestId,
      result: { ok: true, texts: ['a', 'b'] },
    });
    expect(await pending).toEqual({ ok: true, texts: ['a', 'b'] });
    vi.useFakeTimers();
    try {
      const timedOut = env.host.takeBackQueued(session.id);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await timedOut).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects manual compaction while the session is running', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.prompt(session.id, 'work')).toEqual({ ok: true });
    expect(await env.host.compact(session.id)).toMatchObject({ ok: false });
    expect(env.sent('compact')).toHaveLength(0);
    expect(await env.host.compact('missing')).toMatchObject({ ok: false });
  });

  it('keeps grey reply suggestions valid across context metadata events', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'short');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 1,
      event: { type: 'agent_settled', aborted: false, seq: 1 },
    });
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    const snapshot = {
      configuredStrategy: 'native',
      effectiveStrategy: 'native',
      compactionTimeoutMs: 600000,
      recoveryRequired: false,
      pendingPromptCount: 0,
      context: { tokens: 100, contextWindow: 272000, source: 'sdk' },
    };
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 2,
      event: { type: 'context_runtime', snapshot, seq: 2 },
    });
    const result = env.host.suggestReply({ sessionId: session.id, roundId: 1 });
    const command = env.sent('suggest-reply')[0];
    expect(command?.type).toBe('suggest-reply');
    if (command?.type !== 'suggest-reply') throw new Error('missing suggestion command');
    env.worker().emit({ ...command, type: 'suggestion-result', text: 'Show the next step.' });
    expect(await result).toMatchObject({
      ok: true,
      suggestion: { text: 'Show the next step.', roundId: 1 },
    });
  });
  it('passes the configured compaction threshold into the spawn spec only when set', async () => {
    let threshold: number | undefined = 200_000;
    const env = setup({ resolveCompactionThresholdTokens: () => threshold });
    await env.host.prompt((await createSession(env)).id, 'first');
    expect(env.sent('spawn-session')[0]).toMatchObject({
      spec: { compactionThresholdTokens: 200_000 },
    });
    threshold = undefined;
    const other = setup({ resolveCompactionThresholdTokens: () => threshold });
    await other.host.prompt((await createSession(other)).id, 'first');
    expect((other.sent('spawn-session')[0] as { spec: object }).spec).not.toHaveProperty(
      'compactionThresholdTokens'
    );
  });

  it('snapshots spawn policy, forwards ordered state, and accepts one explicit recovery without awaiting compaction', async () => {
    let timeout = 30_000;
    const env = setup({
      resolveCompactionStrategy: () => 'magic-context',
      resolveCompactionTimeoutMs: () => timeout,
    });
    const session = await createSession(env);
    expect(env.host.get(session.id)?.contextRuntime).toBeUndefined();
    await env.host.prompt(session.id, 'first');
    timeout = 60_000;
    const spawn = env.sent('spawn-session')[0];
    expect(spawn).toMatchObject({
      spec: { compactionStrategy: 'magic-context', compactionTimeoutMs: 30_000 },
    });
    const identity = { sessionId: session.id, generation: 1 };
    const snapshot = {
      configuredStrategy: 'magic-context' as const,
      effectiveStrategy: 'magic-context' as const,
      compactionTimeoutMs: 30_000,
      recoveryRequired: true,
      pendingPromptCount: 1,
      context: { tokens: null, contextWindow: 272000, source: 'unknown' as const },
    };
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 1,
      event: { type: 'context_runtime', snapshot, seq: 1 },
    });
    env.worker().emit({ type: 'session-status', identity, status: 'error' });
    expect(env.host.get(session.id)).toMatchObject({
      contextRuntime: snapshot,
      contextRuntimeSeq: 1,
    });
    expect(await env.host.history(session.id)).toMatchObject({
      contextRuntime: snapshot,
      contextRuntimeSeq: 1,
    });
    expect(await env.host.prompt(session.id, 'must stay in UI')).toMatchObject({ ok: false });
    expect(env.sent('prompt')).toHaveLength(1);
    expect(await env.host.retryCompaction(session.id)).toEqual({ ok: true });
    expect(await env.host.retryCompaction(session.id)).toMatchObject({ ok: false });
    await vi.waitFor(() =>
      expect(env.sent('retry-compaction')[0]).toMatchObject({
        identity: { sessionId: session.id, generation: 2 },
      })
    );
    env.worker().emit({
      type: 'session-event',
      identity, // The previous loaded generation is stale after explicit Magic recovery.
      seq: 10,
      event: {
        type: 'context_runtime',
        snapshot: { ...snapshot, recoveryRequired: false },
        seq: 10,
      },
    });
    expect(env.host.get(session.id)?.contextRuntime?.recoveryRequired).toBe(true);
  });
});

class FakeProcess implements WorkerProcess {
  sent: AgentCommand[] = [];
  /** 像真实 worker 一样异步回执 dispose-session；关掉后由用例自己 emit */
  ackDispose = true;
  #onMessage: ((message: unknown) => void) | undefined;
  #onExit: ((code: number) => void) | undefined;
  postMessage(message: unknown): void {
    // 与真实通道一样走结构化克隆
    const command = structuredClone(message) as AgentCommand;
    this.sent.push(command);
    if (command.type === 'dispose-session' && this.ackDispose) {
      queueMicrotask(() => this.emit({ type: 'session-disposed', identity: command.identity }));
    }
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#onMessage = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  kill(): void {}
  emit(message: unknown): void {
    this.#onMessage?.(structuredClone(message));
  }
  exit(code = 1): void {
    this.#onExit?.(code);
  }
}

const tester: Role = {
  id: 'tester',
  name: 'Test Engineer',
  description: 'Writes tests',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};

const anthropic: StoredProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
  apiKey: 'sk-test-secret',
};

/** 生产用的解析器，读内存里的 providers：会话记的是设置里的服务 id，spec 带的是运行时 provider 键 */
const modelsOf = (providers: StoredProvider[]) =>
  createModelResolver({ list: async () => structuredClone(providers) });
const RUNTIME_PROVIDER = runtimeProviderId('https://api.anthropic.com', 'sk-test-secret');

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Partial<AgentHostDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-agent-host-'));
  dirs.push(dir);
  const workspace = {
    id: 'ws-1',
    name: 'demo',
    repoPath: join(dir, 'repo'),
    vcs: 'git' as const,
    defaultBranch: 'main',
  };
  const processes: FakeProcess[] = [];
  const broadcasts: unknown[][] = [];
  const store = createSessionStore({ filePath: join(dir, 'sessions.json') });
  let ids = 0;
  const host = createAgentHost({
    fork: () => {
      const child = new FakeProcess();
      processes.push(child);
      return child;
    },
    agentDir: join(dir, 'agent'),
    store,
    workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
    roles: {
      get: async (id) => getBuiltinRole(id) ?? (id === tester.id ? tester : undefined),
      list: async () => [...BUILTIN_ROLES, tester],
    },
    models: modelsOf([anthropic]),
    broadcast: (...args) => broadcasts.push(args),
    now: () => 1_000,
    newId: () => `session-${++ids}`,
    log: () => {},
    workerOptions: { restartDelayMs: 0 },
    ...overrides,
  });
  host.start();
  const worker = () => processes.at(-1) as FakeProcess;
  worker().emit({ type: 'ready' });
  const sent = (type?: AgentCommand['type']) =>
    worker().sent.filter((command) => !type || command.type === type);
  const pushed = (channel: string) =>
    broadcasts.filter(([name]) => name === channel).map(([, ...args]) => args);
  const events = (sessionId: string) =>
    pushed(IPC_CHANNELS.SESSIONS_EVENT)
      .map(([envelope]) => envelope as SessionEventEnvelope)
      .filter((envelope) => envelope.sessionId === sessionId)
      .map((envelope) => envelope.event);
  return { host, dir, store, workspace, processes, worker, sent, pushed, events, broadcasts };
}

async function createSession(env: ReturnType<typeof setup>, roleId = 'worker') {
  const created = await env.host.create({ workspaceId: 'ws-1', roleId });
  if (!created.ok) throw new Error(created.error);
  return created.session;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('chat attachment copies', () => {
  it('spawn 带会话的副本目录，删除会话时一并删掉', async () => {
    const remove = vi.fn(async (_sessionId: string) => {});
    const env = setup({ attachments: { dirOf: (id) => join('/copies', id), remove } });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    const [spawn] = env.sent('spawn-session');
    expect(spawn?.type === 'spawn-session' && spawn.spec.attachmentsDir).toBe(
      join('/copies', session.id)
    );
    expect(await env.host.remove(session.id)).toEqual({ ok: true });
    await flush();
    expect(remove).toHaveBeenCalledWith(session.id);
  });

  it('副本删除失败只记日志，不阻塞删除会话', async () => {
    const log = vi.fn();
    const remove = vi.fn(async () => {
      throw new Error('busy');
    });
    const env = setup({ attachments: { dirOf: (id) => join('/copies', id), remove }, log });
    const session = await createSession(env);
    expect(await env.host.remove(session.id)).toEqual({ ok: true });
    expect(env.store.get(session.id)).toBeUndefined();
    await flush();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('attachment copies'));
  });
});

describe('explicit abandoned-worker error cleanup', () => {
  function launcher(env: ReturnType<typeof setup>) {
    return env.host.implementsLauncher();
  }

  it.each([false, true])(
    'clears error only on explicit cleanup, preserves jsonl/dispatch and drops late events (loaded: %s)',
    async (loaded) => {
      const env = setup();
      const session = await createSession(env);
      env.store.update(session.id, { dispatchId: 'failed-dispatch' });
      const identity = { sessionId: session.id, generation: 1 };
      if (loaded) {
        await env.host.prompt(session.id, 'failed task');
        env.worker().emit({ type: 'session-status', identity, status: 'error' });
      } else env.store.update(session.id, { status: 'error' });
      const failure = env.host.implementsLauncher().sessionFailure?.(session.id);
      if (loaded) expect(failure).toContain('Worker attempt interrupted');
      const file = sessionFilePath(join(env.dir, 'agent'), session.id);
      mkdirSync(join(env.dir, 'agent', 'sessions'), { recursive: true });
      const jsonl = `${JSON.stringify({ type: 'custom', customType: 'fynvra-context-recovery', data: { blocked: true, resume: true, pending: [{ text: 'held original input' }] } })}\n`;
      writeFileSync(file, jsonl);
      const changedBefore = env.pushed(IPC_CHANNELS.SESSIONS_CHANGED).length;
      const eventsBefore = env.events(session.id).length;
      await launcher(env).disposeSession(session.id, { clearError: true });
      expect(env.host.get(session.id)?.status).toBe('idle');
      expect(env.pushed(IPC_CHANNELS.SESSIONS_CHANGED)).toHaveLength(changedBefore + 1);
      expect(env.store.get(session.id)?.dispatchId).toBe('failed-dispatch');
      expect(env.host.implementsLauncher().sessionFailure?.(session.id)).toBe(failure);
      expect(readFileSync(file, 'utf8')).toBe(jsonl);
      env.worker().emit({ type: 'session-status', identity, status: 'error' });
      env.worker().emit({ type: 'session-status', identity, status: 'running' });
      expect(env.host.get(session.id)?.status).toBe('idle');
      expect(env.events(session.id)).toHaveLength(eventsBefore); // No fake successful settled event.
    }
  );

  it.each([undefined, { clearError: false }])(
    'preserves error on ordinary unload (%j)',
    async (options) => {
      const env = setup();
      const session = await createSession(env);
      await env.host.prompt(session.id, 'failed task');
      env.worker().emit({
        type: 'session-status',
        identity: { sessionId: session.id, generation: 1 },
        status: 'error',
      });
      await launcher(env).disposeSession(session.id, options);
      expect(env.host.get(session.id)?.status).toBe('error');
    }
  );

  it('invalidates an old prompt waiting to spawn instead of resurrecting a cleaned-up session', async () => {
    const resources = Promise.withResolvers<{
      skills: string[];
      mcpServers: [];
      warnings: string[];
    }>();
    const env = setup({ resolveResources: () => resources.promise });
    const session = await createSession(env);
    env.store.update(session.id, { status: 'error' });
    const prompt = env.host.prompt(session.id, 'old queued input');
    await launcher(env).disposeSession(session.id, { clearError: true });
    resources.resolve({ skills: [], mcpServers: [], warnings: [] });
    expect(await prompt).toMatchObject({ ok: false });
    expect(env.sent('spawn-session')).toHaveLength(0);
    expect(env.sent('prompt')).toHaveLength(0);
    expect(env.host.get(session.id)?.status).toBe('idle');
  });

  it('removes the discarded session from pending worker crash respawns', async () => {
    vi.useFakeTimers();
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'failed task');
    env.worker().exit(1);
    expect(env.host.get(session.id)?.status).toBe('error');
    await launcher(env).disposeSession(session.id, { clearError: true });
    await vi.advanceTimersByTimeAsync(0);
    env.worker().emit({ type: 'ready' });
    expect(env.processes).toHaveLength(2);
    expect(env.sent('spawn-session')).toHaveLength(0);
    expect(env.host.get(session.id)?.status).toBe('idle');
  });
});

describe('acknowledged dispose', () => {
  async function spawned() {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'task');
    env.worker().ackDispose = false;
    let done = false;
    const disposing = env.host
      .implementsLauncher()
      .disposeSession(session.id)
      .then(() => {
        done = true;
      });
    return { env, sessionId: session.id, disposing, done: () => done };
  }

  it('waits for session-disposed of the same generation', async () => {
    const { env, sessionId, disposing, done } = await spawned();
    await flush();
    expect(done()).toBe(false);
    env.worker().emit({ type: 'session-disposed', identity: { sessionId, generation: 2 } });
    await flush();
    expect(done()).toBe(false);
    env.worker().emit({ type: 'session-disposed', identity: { sessionId, generation: 1 } });
    await disposing;
  });

  it('stops waiting after 5 s without an ack', async () => {
    vi.useFakeTimers();
    const { done } = await spawned();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
  });

  it('stops waiting when the worker crashes', async () => {
    const { env, disposing } = await spawned();
    env.worker().exit(1);
    await disposing;
  });

  it('resolves at once for a session that was never spawned', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.implementsLauncher().disposeSession(session.id);
    expect(env.sent('dispose-session')).toHaveLength(0);
  });
});

describe('worker attempt lifecycle', () => {
  async function dispatched() {
    const env = setup();
    const launcher = env.host.implementsLauncher();
    const created = await launcher.createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: env.workspace.repoPath,
      brief: 'First attempt',
    });
    if (!created.ok) throw new Error(created.error);
    const identity = { sessionId: created.sessionId, generation: 1 };
    return { ...env, launcher, identity };
  }

  it('production startup wiring recovers a persisted missing attempt before any worker forks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-orphan-startup-'));
    dirs.push(dir);
    const workspace = { id: 'ws-old', name: 'Old tasks', repoPath: dir, vcs: 'none' as const };
    const startedAt = Date.now() - 24 * 60 * 60 * 1000;
    const task = {
      id: 'task_old',
      runId: 'run_old',
      title: 'Old task',
      spec: 'Task brief',
      roleId: 'worker',
      status: 'in-progress',
      dependsOn: [],
    };
    const dispatch = {
      id: 'dispatch_old',
      taskId: task.id,
      workerSessionId: 'session_removed',
      worktreeId: '',
      branch: '',
      mode: 'in-place',
      startedAt,
    };
    const original = {
      version: 1,
      runs: [
        {
          id: task.runId,
          workspaceId: workspace.id,
          coordinatorSessionId: 'coordinator',
          objective: 'Old work',
          createdAt: startedAt,
        },
      ],
      tasks: [task, { ...task, id: 'task_present' }],
      dispatches: [
        {
          ...dispatch,
          id: 'dispatch_prior',
          settledAt: startedAt + 1,
          outcome: 'succeeded',
          summary: 'Previous attempt report',
        },
        { ...dispatch, startedAt: startedAt + 2 },
        {
          ...dispatch,
          id: 'dispatch_present',
          taskId: 'task_present',
          workerSessionId: 'session_present',
        },
      ],
      worktrees: [],
      messages: [],
    };
    mkdirSync(join(dir, 'orchestration'));
    const statePath = join(dir, 'orchestration', `${workspace.id}.json`);
    writeFileSync(statePath, JSON.stringify(original));
    const sessionsPath = join(dir, 'sessions.json');
    const sessionsText = JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 'session_present',
          workspaceId: workspace.id,
          roleId: 'worker',
          title: 'Restored worker',
          cwd: dir,
          status: 'idle',
          createdAt: startedAt,
          updatedAt: startedAt,
          approvalMode: 'supervised',
        },
      ],
    });
    writeFileSync(sessionsPath, sessionsText);
    const fork = vi.fn(() => {
      throw new Error('Startup recovery must not fork a worker');
    });
    const roles = createFakeRoles();
    const host = createAgentHost({
      fork,
      agentDir: join(dir, 'agent'),
      store: createSessionStore({ filePath: sessionsPath }),
      workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
      roles,
      models: { resolve: async () => ({ ok: false, error: 'No model needed for recovery' }) },
      broadcast: vi.fn(),
    });
    const notifyChanged = vi.fn();
    const registry = createOrchestrationRegistry({
      userDataPath: dir,
      listWorkspaces: () => [workspace],
      roles,
      notifyChanged,
    });
    // Same ordering as index.ts: create the host (synchronously load sessions), connect, then start.
    await connectOrchestration(host, registry);
    const recovered = await registry.readSnapshot(workspace.id);
    expect(recovered?.tasks.map((entry) => entry.status)).toEqual(['failed', 'in-progress']);
    expect(recovered?.dispatches[0]).toEqual(original.dispatches[0]);
    expect(recovered?.dispatches[1]).toMatchObject({
      outcome: 'failed',
      summary: expect.stringContaining('missing from the session registry'),
    });
    expect(recovered?.dispatches[2]).toEqual(original.dispatches[2]);
    expect(notifyChanged).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect(fork).not.toHaveBeenCalled();
    expect(readFileSync(sessionsPath, 'utf8')).toBe(sessionsText);
    await registry.flushAll();
    const persisted = readFileSync(statePath, 'utf8');
    expect(JSON.parse(persisted).tasks[0].status).toBe('failed');
    notifyChanged.mockClear();
    expect(await registry.serviceFor(workspace.id)?.snapshot()).toEqual(recovered);
    await registry.flushAll();
    expect(readFileSync(statePath, 'utf8')).toBe(persisted);
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it('delivers busy instructions, answers later questions and isolates retries through registry wiring', async () => {
    const env = setup();
    const registry = createOrchestrationRegistry({
      userDataPath: env.dir,
      listWorkspaces: () => [env.workspace],
      roles: createFakeRoles(),
      launcher: env.host.implementsLauncher(),
      notifyChanged: vi.fn(),
      exec: createFakeExec().exec,
      runChecks: async () => ({ exitCode: 0, output: '', durationMs: 0 }),
    });
    env.host.setWorkerHostFactory((sessionId) => registry.workerHostFor(sessionId));
    const coordinator = registry.hostFor('coordinator', env.workspace.id);
    const launched = await coordinator?.dispatchTask({
      title: 'Task',
      spec: 'Do it',
      roleId: 'worker',
      dependsOn: [],
    });
    if (!launched?.ok || !launched.dispatch) throw new Error('dispatch failed');
    const dispatch = launched.dispatch;
    const identity = { sessionId: dispatch.workerSessionId, generation: 1 };
    // No question exists yet. A normal instruction must return while this run remains busy,
    // otherwise a later ask_coordinator would deadlock behind send_to_worker.
    let instructionReturned = false;
    const instruction = coordinator?.sendToWorker({
      dispatchId: dispatch.id,
      body: 'Check the API shape',
    });
    void instruction?.then(() => {
      instructionReturned = true;
    });
    await vi.waitFor(() => expect(instructionReturned).toBe(true));
    expect(await instruction).toMatchObject({ ok: true, type: 'instruction' });
    expect(env.sent('prompt')).toHaveLength(2);
    expect(env.sent('prompt').at(-1)).toMatchObject({
      text: expect.stringContaining('Check the API shape'),
    });
    expect(env.host.get(identity.sessionId)?.status).toBe('running');

    env.worker().emit({
      type: 'host-invoke',
      identity,
      callId: 'later-question',
      kind: 'worker',
      method: 'askCoordinator',
      input: { question: 'Which API should I use?', timeoutMs: 1000 },
    });
    expect(
      await coordinator?.sendToWorker({ dispatchId: dispatch.id, body: 'Use REST' })
    ).toMatchObject({ ok: true, type: 'reply' });
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({
      callId: 'later-question',
      result: { ok: true, answer: 'Use REST' },
    });
    expect(env.sent('prompt')).toHaveLength(2); // The answer goes to the inbox, not a new prompt.
    const report = (callId: string) =>
      env.worker().emit({
        type: 'host-invoke',
        identity,
        callId,
        kind: 'worker',
        method: 'reportDone',
        input: { outcome: 'succeeded', summary: callId },
      });
    report('first');
    await flush();
    const retry = coordinator?.rejectWork({
      dispatchId: dispatch.id,
      feedback: 'Fix review feedback',
    });
    await flush();
    report('late first report');
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({ result: { ok: false } });
    expect(env.sent('prompt')).toHaveLength(2);
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(await retry).toMatchObject({ ok: true });
    expect(env.sent('prompt')).toHaveLength(3);
    report('retry report');
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({ result: { ok: true } });
    const service = registry.serviceFor(env.workspace.id);
    const snapshot = await service?.snapshot();
    expect(snapshot?.dispatches.map((entry) => entry.summary)).toEqual(['first', 'retry report']);
    expect(snapshot?.tasks[0]?.status).toBe('in-review');
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    const retryId = snapshot?.dispatches[1]?.id ?? '';
    expect(
      await coordinator?.rejectWork({ dispatchId: retryId, feedback: 'One more check' })
    ).toMatchObject({ ok: true });
    await env.host.remove(identity.sessionId);
    // readSnapshot intentionally does not reconcile: this proves the removal event already did.
    const removed = await registry.readSnapshot(env.workspace.id);
    expect(removed?.tasks[0]?.status).toBe('failed');
    expect(removed?.dispatches.map((entry) => entry.outcome)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
    ]);
    expect(removed?.dispatches[2]?.summary).toContain('missing from the session registry');
    expect(removed?.worktrees).toHaveLength(1);
    await registry.flushAll();
  });

  it('waits for an actual idle boundary and pins old host calls while retry feedback is queued', async () => {
    const env = await dispatched();
    const { sessionId } = env.identity;
    const first: WorkerHost = {
      askCoordinator: vi.fn<WorkerHost['askCoordinator']>(async () => ({ ok: true, answer: null })),
      reportDone: vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true })),
    };
    const next: WorkerHost = {
      ...first,
      askCoordinator: vi.fn<WorkerHost['askCoordinator']>(async () => ({ ok: true, answer: null })),
      reportDone: vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true })),
    };
    let current = first;
    env.host.setWorkerHostFactory(() => current);
    const report = (callId: string) =>
      env.worker().emit({
        type: 'host-invoke',
        identity: env.identity,
        callId,
        kind: 'worker',
        method: 'reportDone',
        input: { outcome: 'succeeded', summary: callId },
      });
    const question = (callId: string) =>
      env.worker().emit({
        type: 'host-invoke',
        identity: env.identity,
        callId,
        kind: 'worker',
        method: 'askCoordinator',
        input: { question: callId, timeoutMs: 60_000 },
      });
    report('first');
    await flush();
    current = next; // reject_work registered its next dispatch while the old run is finishing.
    const delivery = env.launcher.promptSession(sessionId, 'Review feedback', {
      freshAttempt: true,
    });
    await flush();
    env
      .worker()
      .emit({ type: 'session-status', identity: env.identity, status: 'waiting-approval' });
    await flush();
    expect(env.sent('prompt')).toHaveLength(1);
    expect(env.launcher.sessionFailure?.(sessionId)).toBeUndefined();
    expect(await env.host.steer(sessionId, 'User steering remains immediate')).toEqual({
      ok: true,
    });
    expect(env.sent('steer')).toHaveLength(1);
    expect(env.sent('prompt')).toHaveLength(1);
    report('late');
    question('old question');
    await flush();
    expect(first.reportDone).toHaveBeenCalledTimes(2);
    expect(first.askCoordinator).toHaveBeenCalledWith(
      'old question',
      60_000,
      expect.any(AbortSignal)
    );
    expect(next.reportDone).not.toHaveBeenCalled();
    expect(next.askCoordinator).not.toHaveBeenCalled();
    env.worker().emit({ type: 'session-status', identity: env.identity, status: 'idle' });
    expect(await delivery).toEqual({ ok: true });
    expect(env.sent('prompt')).toHaveLength(2);
    report('retry');
    question('new question');
    await flush();
    expect(next.reportDone).toHaveBeenCalledWith('succeeded', 'retry', undefined);
    expect(next.askCoordinator).toHaveBeenCalledWith(
      'new question',
      60_000,
      expect.any(AbortSignal)
    );
  });

  it.each(['remove', 'abort', 'dispose'] as const)(
    'does not revive queued feedback after %s',
    async (stop) => {
      const env = await dispatched();
      const pending = env.launcher.promptSession(env.identity.sessionId, 'Review feedback', {
        freshAttempt: true,
      });
      await flush();
      if (stop === 'dispose') await env.launcher.disposeSession(env.identity.sessionId);
      else await env.host[stop](env.identity.sessionId);
      expect(await pending).toMatchObject({ ok: false });
      expect(env.sent('prompt')).toHaveLength(1);
    }
  );

  it('does not treat restored idle/error or never-spawned sessions as interrupted', async () => {
    const env = setup();
    const session = await createSession(env);
    const launcher = env.host.implementsLauncher();
    expect(launcher.sessionFailure?.(session.id)).toBeUndefined();
    env.store.update(session.id, { status: 'error' });
    expect(launcher.sessionFailure?.(session.id)).toBeUndefined();
    expect(env.sent('spawn-session')).toHaveLength(0);
    expect(launcher.sessionFailure?.('missing')).toContain('missing from the session registry');
  });

  it('records only definitive termination, drops stale generations, and notifies on removal', async () => {
    const env = await dispatched();
    const { sessionId } = env.identity;
    const changed = vi.fn();
    env.launcher.onSessionFailure?.(changed);
    env.worker().emit({
      type: 'session-error',
      identity: env.identity,
      fatal: false,
      error: 'Temporary failure',
    });
    expect(env.launcher.sessionFailure?.(sessionId)).toBeUndefined();
    env.worker().emit({
      type: 'session-error',
      identity: { ...env.identity, generation: 0 },
      fatal: true,
      error: 'Stale failure',
    });
    expect(changed).not.toHaveBeenCalled();
    env.worker().emit({
      type: 'session-error',
      identity: env.identity,
      fatal: true,
      error: 'Session could not start',
    });
    expect(env.launcher.sessionFailure?.(sessionId)).toContain('Session could not start');
    expect(changed).toHaveBeenCalledTimes(1);
    await env.host.remove(sessionId);
    expect(env.launcher.sessionFailure?.(sessionId)).toContain('missing from the session registry');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('records a running worker process crash without mistaking automatic respawn for recovery', async () => {
    const env = await dispatched();
    const changed = vi.fn();
    env.launcher.onSessionFailure?.(changed);
    env.worker().exit(7);
    expect(env.launcher.sessionFailure?.(env.identity.sessionId)).toContain('exited (code 7)');
    expect(changed).toHaveBeenCalledTimes(1);
    await flush();
    env.worker().emit({ type: 'ready' });
    expect(env.launcher.sessionFailure?.(env.identity.sessionId)).toContain('exited (code 7)');
    expect(
      await env.launcher.promptSession(env.identity.sessionId, 'Explicit retry', {
        freshAttempt: true,
      })
    ).toEqual({
      ok: true,
    });
    expect(env.launcher.sessionFailure?.(env.identity.sessionId)).toBeUndefined();
  });
});

describe('automatic coordinator continuation delivery', () => {
  it('sends one prompt only while idle, without treating it as a user continuation', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    const activity = vi.fn();
    env.host.observe({ activity });
    const first = env.host.promptWhenIdle(session.id, 'Review the worker');
    expect(await env.host.promptWhenIdle(session.id, 'Duplicate')).toEqual({
      ok: true,
      delivered: false,
    });
    expect(await first).toEqual({ ok: true, delivered: true });
    expect(env.sent('prompt')).toHaveLength(1);
    expect(activity).not.toHaveBeenCalledWith(session.id, 'prompt');
    expect(await env.host.promptWhenIdle(session.id, 'Still busy')).toEqual({
      ok: true,
      delivered: false,
    });
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'waiting-approval' });
    expect(await env.host.promptWhenIdle(session.id, 'Approval pending')).toEqual({
      ok: true,
      delivered: false,
    });
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(activity).toHaveBeenCalledWith(session.id, 'idle');
    expect(await env.host.promptWhenIdle(session.id, 'Continue review')).toEqual({
      ok: true,
      delivered: true,
    });
    expect(env.sent('prompt')).toHaveLength(2);
  });

  it('带图片时随 prompt 投递，忙时不发', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    const images = [{ data: 'aGk=', mimeType: 'image/png' as const }];
    expect(await env.host.promptWhenIdle(session.id, 'look', images)).toEqual({
      ok: true,
      delivered: true,
    });
    expect(env.sent('prompt')).toEqual([expect.objectContaining({ text: 'look', images })]);
    expect(await env.host.promptWhenIdle(session.id, 'again', images)).toEqual({
      ok: true,
      delivered: false,
    });
    expect(env.sent('prompt')).toHaveLength(1);
  });

  it.each(['prompt', 'steer'] as const)(
    'lets a user %s during spawn supersede automatic delivery',
    async (method) => {
      const env = setup();
      const session = await createSession(env, 'orchestrator');
      const activity = vi.fn();
      env.host.observe({ activity });
      const automatic = env.host.promptWhenIdle(session.id, 'Automatic review');
      const user = env.host[method](session.id, 'New instructions');
      expect(await automatic).toEqual({ ok: true, delivered: false });
      expect(await user).toEqual({ ok: true });
      expect(env.sent(method)).toEqual([
        expect.objectContaining({ type: method, text: 'New instructions' }),
      ]);
      expect(
        env
          .sent('prompt')
          .some((command) => command.type === 'prompt' && command.text === 'Automatic review')
      ).toBe(false);
      expect(activity).toHaveBeenCalledWith(session.id, 'prompt');
    }
  );

  it('invalidates a pending automatic spawn immediately on abort, even before a worker exists', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    const activity = vi.fn();
    env.host.observe({ activity });
    const automatic = env.host.promptWhenIdle(session.id, 'Automatic review');
    expect(await env.host.abort(session.id)).toEqual({ ok: true });
    expect(activity).toHaveBeenCalledWith(session.id, 'abort');
    expect(await automatic).toEqual({ ok: true, delivered: false });
    expect(env.sent('prompt')).toEqual([]);
  });

  it('does not revive archived/error sessions or send a prompt after disposal during spawn', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    env.store.update(session.id, { archivedAt: 1 });
    expect(await env.host.promptWhenIdle(session.id, 'Archived')).toEqual({
      ok: true,
      delivered: false,
    });
    env.store.update(session.id, { archivedAt: undefined, status: 'error' });
    expect(await env.host.promptWhenIdle(session.id, 'Error')).toEqual({
      ok: true,
      delivered: false,
    });
    env.store.update(session.id, { status: 'idle' });
    const automatic = env.host.promptWhenIdle(session.id, 'Automatic review');
    await env.host.implementsLauncher().disposeSession(session.id);
    expect(await automatic).toEqual({ ok: true, delivered: false });
    expect(env.sent('prompt')).toEqual([]);
  });
});

describe('会话守护的自动恢复 resumeAfterInterruption', () => {
  it('接受 error 会话：发一条 prompt、置为 running 并通知 resume，不算用户 prompt', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    const activity = vi.fn();
    env.host.observe({ activity });
    env.store.update(session.id, { status: 'error' });
    expect(await env.host.resumeAfterInterruption(session.id, 'Resume please')).toEqual({
      ok: true,
      delivered: true,
    });
    expect(env.sent('prompt')).toEqual([
      expect.objectContaining({ type: 'prompt', text: 'Resume please' }),
    ]);
    expect(env.host.get(session.id)?.status).toBe('running');
    expect(activity).toHaveBeenCalledWith(session.id, 'resume');
    expect(activity).not.toHaveBeenCalledWith(session.id, 'prompt');
    // 已在运行：拒绝
    expect(await env.host.resumeAfterInterruption(session.id, 'Again')).toEqual({
      ok: true,
      delivered: false,
    });
    expect(env.sent('prompt')).toHaveLength(1);
  });

  it('拒绝已归档、普通 idle（用户点停止）的会话；fromIdle 时接受 idle', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    env.store.update(session.id, { status: 'error', archivedAt: 1 });
    expect(await env.host.resumeAfterInterruption(session.id, 'Archived')).toEqual({
      ok: true,
      delivered: false,
    });
    env.store.update(session.id, { archivedAt: undefined, status: 'idle' });
    expect(await env.host.resumeAfterInterruption(session.id, 'Idle')).toEqual({
      ok: true,
      delivered: false,
    });
    expect(env.sent('prompt')).toEqual([]);
    expect(
      await env.host.resumeAfterInterruption(session.id, 'Stalled', { fromIdle: true })
    ).toEqual({ ok: true, delivered: true });
  });

  it('spawn 期间用户发消息时让位', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    env.store.update(session.id, { status: 'error' });
    const automatic = env.host.resumeAfterInterruption(session.id, 'Automatic resume');
    const user = env.host.prompt(session.id, 'User turn');
    expect(await automatic).toEqual({ ok: true, delivered: false });
    expect(await user).toEqual({ ok: true });
    expect(env.sent('prompt')).toEqual([
      expect.objectContaining({ type: 'prompt', text: 'User turn' }),
    ]);
  });
});

describe('createAgentHost sessions', () => {
  it('creates a session from workspace, role and model without touching the worker', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(session).toEqual({
      id: 'session-1',
      workspaceId: 'ws-1',
      roleId: 'worker',
      title: 'Worker',
      cwd: env.workspace.repoPath,
      status: 'idle',
      createdAt: 1_000,
      updatedAt: 1_000,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
      approvalMode: 'auto-edits',
    });
    expect(env.host.list('ws-1')).toEqual([session]);
    expect(env.pushed(IPC_CHANNELS.SESSIONS_CHANGED)).toEqual([['ws-1']]);
    expect(env.sent()).toEqual([]);
  });

  it('summaries carry awaitingWorkers from the injected active-work lookup', async () => {
    const env = setup();
    const coordinator = await createSession(env, 'orchestrator');
    expect(env.host.get(coordinator.id)?.awaitingWorkers).toBeUndefined();
    let active = true;
    env.host.setActiveWorkLookup((sessionId) => active && sessionId === coordinator.id);
    expect(env.host.list('ws-1')[0]?.awaitingWorkers).toBe(true);
    active = false;
    expect(env.host.list('ws-1')[0]).not.toHaveProperty('awaitingWorkers');
  });

  it("records the role's approval mode; a dispatched worker inherits the coordinator's current one", async () => {
    const careful: Role = { ...tester, id: 'careful', name: 'Careful', approvalMode: 'supervised' };
    const env = setup({
      roles: {
        get: async (id) => getBuiltinRole(id) ?? [tester, careful].find((role) => role.id === id),
        list: async () => [...BUILTIN_ROLES, tester, careful],
      },
    });
    const coordinator = await createSession(env, 'orchestrator');
    expect(coordinator.approvalMode).toBe('full');
    expect((await createSession(env, 'careful')).approvalMode).toBe('supervised');

    env.host.setCoordinatorLookup(() => coordinator.id);
    const dispatch = async () => {
      const created = await env.host.implementsLauncher().createWorkerSession({
        workspaceId: 'ws-1',
        runId: 'run_1',
        dispatchId: `dsp_${env.host.list('ws-1').length}`,
        roleId: 'tester',
        cwd: '/worktrees/ws-1/a',
        worktreeId: 'wt_1',
        brief: '# A',
      });
      if (!created.ok) throw new Error(created.error);
      return env.host.list('ws-1').find((session) => session.id === created.sessionId);
    };
    // 主 agent 当前是 full：worker 带过去的是 full，不是角色自己的 auto-edits
    expect(await dispatch()).toMatchObject({
      parentSessionId: coordinator.id,
      approvalMode: 'full',
    });
    // 主 agent 切成 supervised 后再派：新 worker 跟随新档位
    await env.host.setApprovalMode({ sessionId: coordinator.id, mode: 'supervised' });
    expect(await dispatch()).toMatchObject({ approvalMode: 'supervised' });
    // 没有主 agent（未接线）：按受限处理（fail-closed），档位固定兜底的 supervised
    env.host.setCoordinatorLookup(() => undefined);
    expect(await dispatch()).toMatchObject({ profile: 'restricted', approvalMode: 'supervised' });
    // 落盘的也是它们
    expect(env.store.flush()).toBe(true);
    const file = JSON.parse(readFileSync(join(env.dir, 'sessions.json'), 'utf8'));
    expect(
      file.sessions.map((session: { roleId: string; approvalMode: string }) => [
        session.roleId,
        session.approvalMode,
      ])
    ).toEqual([
      ['orchestrator', 'supervised'],
      ['careful', 'supervised'],
      ['tester', 'full'],
      ['tester', 'supervised'],
      ['tester', 'supervised'],
    ]);
  });

  it('keeps the settings model reference on the session and resolves it again on spawn', async () => {
    const env = setup();
    const created = await env.host.create({
      workspaceId: 'ws-1',
      roleId: 'worker',
      model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5' },
    });
    if (!created.ok) throw new Error(created.error);
    // 设置里的服务 id，不是运行时 provider 键：Renderer 用它对照模型服务，spawn 时再按它解析
    expect(created.session.model).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-5-5' });
    expect(await env.host.prompt(created.session.id, 'hi')).toEqual({ ok: true });
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec.model).toEqual({
      providerId: RUNTIME_PROVIDER,
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-secret',
      modelId: 'claude-haiku-5-5',
    });
  });

  it('refuses unknown workspaces and roles, and models it cannot resolve', async () => {
    const env = setup({ models: modelsOf([]) });
    expect(await env.host.create({ workspaceId: 'nope', roleId: 'worker' })).toMatchObject({
      ok: false,
    });
    expect(await env.host.create({ workspaceId: 'ws-1', roleId: 'ghost' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('ghost'),
    });
    expect(await env.host.create({ workspaceId: 'ws-1', roleId: 'worker' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('模型服务'),
    });
    expect(env.host.list('ws-1')).toEqual([]);
  });

  it('spawns on the first prompt, then prompts; titles the session from the prompt', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.prompt(session.id, '## Fix the flaky build\nDetails...')).toEqual({
      ok: true,
    });
    expect(env.sent().map((command) => command.type)).toEqual(['spawn-session', 'prompt']);
    expect(env.sent('spawn-session')[0]).toEqual({
      type: 'spawn-session',
      identity: { sessionId: session.id, generation: 1 },
      spec: {
        role: getBuiltinRole('worker'),
        cwd: env.workspace.repoPath,
        sessionFile: sessionFilePath(join(env.dir, 'agent'), session.id),
        compactionStrategy: 'magic-context',
        compactionTimeoutMs: 600_000,
        model: {
          providerId: RUNTIME_PROVIDER,
          api: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-test-secret',
          modelId: 'claude-sonnet-5-5',
        },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
    });
    expect(env.host.list('ws-1')[0]).toMatchObject({
      title: 'Fix the flaky build',
      status: 'running',
    });

    await env.host.prompt(session.id, 'second message');
    expect(env.sent().map((command) => command.type)).toEqual([
      'spawn-session',
      'prompt',
      'prompt',
    ]);
    expect(env.host.list('ws-1')[0]?.title).toBe('Fix the flaky build');
  });

  it('sends the pasted images with the prompt, and only when there are some', async () => {
    const env = setup();
    const session = await createSession(env);
    const screenshot: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const identity = { sessionId: session.id, generation: 1 };
    expect(await env.host.prompt(session.id, 'What is wrong here?', [screenshot])).toEqual({
      ok: true,
    });
    await env.host.prompt(session.id, '', [screenshot]);
    await env.host.prompt(session.id, 'text only');
    expect(env.sent('prompt')).toEqual([
      { type: 'prompt', identity, text: 'What is wrong here?', images: [screenshot] },
      { type: 'prompt', identity, text: '', images: [screenshot] },
      { type: 'prompt', identity, text: 'text only' },
    ]);
    expect(env.sent('prompt')[2]).not.toHaveProperty('images');
  });

  it('sends steer commands (with images when there are some) for sessions:steer', async () => {
    const env = setup();
    const session = await createSession(env);
    const screenshot: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const identity = { sessionId: session.id, generation: 1 };
    expect(await env.host.steer(session.id, 'also check docs')).toEqual({ ok: true });
    await env.host.steer(session.id, 'look', [screenshot]);
    expect(env.sent('steer')).toEqual([
      { type: 'steer', identity, text: 'also check docs' },
      { type: 'steer', identity, text: 'look', images: [screenshot] },
    ]);
    expect(env.host.list('ws-1')[0]?.status).toBe('running');
  });

  it('keeps the automatic title for the next message when a message has only images', async () => {
    const env = setup();
    const session = await createSession(env);
    const screenshot: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    await env.host.prompt(session.id, '', [screenshot]);
    expect(env.host.list('ws-1')[0]).toMatchObject({ title: 'Worker', status: 'running' });

    await env.host.prompt(session.id, 'Why does the build fail here?', [screenshot]);
    expect(env.host.list('ws-1')[0]?.title).toBe('Why does the build fail here?');
    await env.host.prompt(session.id, 'second message');
    expect(env.host.list('ws-1')[0]?.title).toBe('Why does the build fail here?');
  });

  it('spawns with the skills and MCP servers resolved for the role and logs their warnings', async () => {
    const logs: string[] = [];
    const resolveResources = vi.fn(async () => ({
      skills: ['/skills/pdf'],
      mcpServers: [{ name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'ghp_secret' } }],
      warnings: ['skill "gone" of role "tester" is no longer registered; skipped'],
      instructionFile: { name: 'CLAUDE.md', content: 'Selected instruction content' },
    }));
    const env = setup({
      resolveResources,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    const session = await createSession(env, 'tester');
    await env.host.prompt(session.id, 'go');

    expect(resolveResources).toHaveBeenCalledWith(tester);
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec).toMatchObject({
      instructionFile: { name: 'CLAUDE.md', content: 'Selected instruction content' },
      skills: ['/skills/pdf'],
      mcpServers: [{ name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'ghp_secret' } }],
    });
    expect(logs).toContain(
      `warn: session ${session.id}: skill "gone" of role "tester" is no longer registered; skipped`
    );
    // MCP env 明文只走 Main → worker 这一跳
    expect(JSON.stringify(env.broadcasts)).not.toContain('ghp_secret');
  });

  it('gives orchestrator sessions the role list for dispatch_task', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'plan');
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec.roles).toEqual([
      { id: 'orchestrator', name: 'Orchestrator', description: expect.any(String) },
      { id: 'worker', name: 'Worker', description: expect.any(String) },
      { id: 'tester', name: 'Test Engineer', description: 'Writes tests' },
    ]);
  });

  it('从磁盘加载内置覆盖配置启动新会话，后续编辑不会强制重启已有会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fynvra-role-overrides-'));
    dirs.push(root);
    const roles = new JsonFileRoleStore({ fs, dir: join(root, 'roles') });
    const edited: Role = {
      ...(getBuiltinRole('orchestrator') as Role),
      systemPrompt: '按我的参考提示词执行',
      skillIds: ['tdd'],
      mcpServerIds: ['pencil'],
      approvalMode: 'supervised',
    };
    expect((await roles.save(edited)).ok).toBe(true);
    const resolveResources = vi.fn(async (role: Role) => ({
      skills: role.skillIds.map((id) => `/skills/${id}`),
      mcpServers: role.mcpServerIds.map((name) => ({ name, command: 'test-mcp' })),
      warnings: [],
    }));
    const env = setup({ roles, resolveResources });
    const first = await createSession(env, 'orchestrator');
    await env.host.prompt(first.id, '验证修改后的配置');
    expect(resolveResources).toHaveBeenCalledWith(edited);
    const initial = env.sent('spawn-session')[0];
    expect(initial?.type === 'spawn-session' && initial.spec).toMatchObject({
      role: edited,
      skills: ['/skills/tdd'],
      mcpServers: [{ name: 'pencil', command: 'test-mcp' }],
    });
    const { systemPrompt: _prompt, ...rest } = edited;
    const cleared = { ...rest, skillIds: [], mcpServerIds: [] };
    await roles.save(cleared);
    const second = await createSession(env, 'orchestrator');
    await env.host.prompt(second.id, '验证清空后的配置');
    const latest = env.sent('spawn-session')[1];
    expect(latest?.type === 'spawn-session' && latest.spec).toMatchObject({
      role: cleared,
      skills: [],
      mcpServers: [],
    });
    expect(latest?.type === 'spawn-session' && latest.spec.role).not.toHaveProperty('systemPrompt');
    await env.host.prompt(first.id, '继续原会话');
    expect(env.sent('spawn-session')).toHaveLength(2);
    expect(env.sent('dispose-session')).toHaveLength(0);
  });

  it('snapshots command proxy settings for new/restored sessions without restarting live sessions', async () => {
    let networkProxy: SpawnSessionSpec['networkProxy'] = {
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
      gitCompatibility: true,
    };
    const env = setup({ resolveNetworkProxy: () => networkProxy });
    const first = await createSession(env);
    await env.host.prompt(first.id, 'first');
    expect(env.sent('spawn-session')[0]).toMatchObject({ spec: { networkProxy } });
    networkProxy = { mode: 'environment', gitCompatibility: false };
    await env.host.prompt(first.id, 'continue');
    expect(env.sent('spawn-session')).toHaveLength(1);
    const second = await createSession(env);
    await env.host.prompt(second.id, 'new');
    expect(env.sent('spawn-session')[1]).toMatchObject({ spec: { networkProxy } });
    expect(env.sent('dispose-session')).toHaveLength(0);
    await env.host.implementsLauncher().disposeSession(first.id);
    await env.host.prompt(first.id, 'resume');
    expect(env.sent('spawn-session').at(-1)).toMatchObject({ spec: { networkProxy } });
  });

  it('spawns with the shell path the resolver gives, and leaves it out when there is none', async () => {
    const resolveShellPath = vi.fn(async () => 'D:\\Software\\Git\\bin\\bash.exe');
    const env = setup({ resolveShellPath });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'git --version');
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec.shellPath).toBe(
      'D:\\Software\\Git\\bin\\bash.exe'
    );
    expect(resolveShellPath).toHaveBeenCalledTimes(1);

    const fallback = setup({ resolveShellPath: async () => undefined });
    await fallback.host.prompt((await createSession(fallback)).id, 'git --version');
    const spawned = fallback.sent('spawn-session')[0];
    expect(spawned?.type === 'spawn-session' && spawned.spec).not.toHaveProperty('shellPath');
  });

  it('spawns sessions of a workspace without git with inPlace, a dispatched one without a worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-agent-host-plain-'));
    dirs.push(dir);
    const plain = { id: 'ws-1', name: 'notes', repoPath: join(dir, 'notes'), vcs: 'none' as const };
    const env = setup({ workspaces: { get: (id) => (id === plain.id ? plain : undefined) } });
    const coordinator = await createSession(env, 'orchestrator');
    await env.host.prompt(coordinator.id, 'plan');
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec).toMatchObject({
      cwd: plain.repoPath,
      inPlace: true,
    });

    env.host.setCoordinatorLookup(() => coordinator.id);
    const created = await env.host.implementsLauncher().createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: plain.repoPath,
      brief: '# Create hello.txt',
    });
    if (!created.ok) throw new Error(created.error);
    const worker = env.host.list('ws-1').find((session) => session.id === created.sessionId);
    expect(worker).toMatchObject({ cwd: plain.repoPath, dispatchId: 'dsp_1' });
    expect(worker).not.toHaveProperty('worktreeId');
    const spawned = env.sent('spawn-session').at(-1);
    expect(spawned?.type === 'spawn-session' && spawned.spec).toMatchObject({
      worker: true,
      inPlace: true,
    });

    // git 工作区的会话不带 inPlace
    const git = setup();
    await git.host.prompt((await createSession(git, 'orchestrator')).id, 'plan');
    const gitSpawn = git.sent('spawn-session')[0];
    expect(gitSpawn?.type === 'spawn-session' && gitSpawn.spec).not.toHaveProperty('inPlace');
  });

  it('re-stamps worker events per session and drops stale generations and duplicate seqs', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    const identity = { sessionId: session.id, generation: 1 };
    const event = (seq: number, delta: string) => ({
      type: 'session-event',
      identity,
      seq,
      event: { type: 'text_delta', delta, seq },
    });
    env.worker().emit(event(1, 'a'));
    env.worker().emit(event(2, 'b'));
    env.worker().emit(event(2, 'dup'));
    env.worker().emit({ ...event(3, 'stale'), identity: { ...identity, generation: 0 } });
    env
      .worker()
      .emit({ type: 'session-event', identity, seq: 9, event: { type: 'text_delta', delta: 'x' } });
    expect(env.events(session.id)).toEqual([
      { type: 'text_delta', delta: 'a', seq: 1 },
      { type: 'text_delta', delta: 'b', seq: 2 },
    ]);

    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
  });

  it('marks a fatal session error and re-spawns with a new generation on the next prompt', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().emit({
      type: 'session-error',
      identity: { sessionId: session.id, generation: 1 },
      error: 'failed to start the session: no base URL',
      fatal: true,
    });
    expect(env.events(session.id)).toEqual([
      {
        type: 'error',
        source: 'host',
        message: 'failed to start the session: no base URL',
        seq: 1,
      },
    ]);
    expect(env.host.list('ws-1')[0]?.status).toBe('error');

    await env.host.prompt(session.id, 'again');
    const spawns = env.sent('spawn-session');
    expect(
      spawns.map((command) => command.type === 'spawn-session' && command.identity.generation)
    ).toEqual([1, 2]);
    expect(env.sent('prompt').at(-1)).toMatchObject({ identity: { generation: 2 }, text: 'again' });
  });

  it('aborts, removes and reads history', async () => {
    const env = setup();
    const session = await createSession(env);
    expect(await env.host.abort(session.id)).toEqual({ ok: true });
    expect(env.sent()).toEqual([]);
    await env.host.prompt(session.id, 'hi');
    await env.host.abort(session.id);
    expect(env.sent('abort')).toEqual([
      { type: 'abort', identity: { sessionId: session.id, generation: 1 } },
    ]);

    expect(await env.host.history(session.id)).toEqual({
      ok: true,
      messages: [],
      contextRuntimeSeq: 0,
    });
    const file = sessionFilePath(join(env.dir, 'agent'), session.id);
    mkdirSync(join(env.dir, 'agent', 'sessions'), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/' })}\n${JSON.stringify(
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: 't',
          message: { role: 'user', content: 'hi', timestamp: 5 },
        }
      )}\n`
    );
    expect(await env.host.history(session.id)).toMatchObject({
      ok: true,
      messages: [{ id: 'u1', role: 'user', text: 'hi', sessionId: session.id }],
    });

    expect(await env.host.remove(session.id)).toEqual({ ok: true });
    expect(env.sent('dispose-session')).toHaveLength(1);
    expect(env.host.list('ws-1')).toEqual([]);
    expect(await env.host.history(session.id)).toMatchObject({ ok: false });
    expect(await env.host.prompt(session.id, 'x')).toMatchObject({ ok: false });
  });

  it('removing a session with a worktree removes the worktree first; refusals and failures keep the record', async () => {
    const removeWorktree = vi.fn<NonNullable<AgentHostDeps['removeWorktree']>>(async () => ({
      ok: false,
      error: 'blocked: not-merged',
    }));
    const env = setup({ removeWorktree });
    const plain = await createSession(env);
    const worker = await createSession(env);
    env.store.update(worker.id, { worktreeId: 'wt-1' });

    expect(await env.host.remove(plain.id)).toEqual({ ok: true });
    expect(removeWorktree).not.toHaveBeenCalled();

    env.store.update(worker.id, { status: 'running' });
    expect(await env.host.remove(worker.id, true)).toMatchObject({ ok: false });
    expect(removeWorktree).not.toHaveBeenCalled();
    env.store.update(worker.id, { status: 'idle' });

    expect(await env.host.remove(worker.id)).toEqual({ ok: false, error: 'blocked: not-merged' });
    expect(removeWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: worker.id }),
      false
    );
    expect(env.host.list('ws-1').map((session) => session.id)).toEqual([worker.id]);

    removeWorktree.mockResolvedValueOnce({ ok: true });
    expect(await env.host.remove(worker.id, true)).toEqual({ ok: true });
    expect(removeWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: worker.id }),
      true
    );
    expect(env.host.list('ws-1')).toEqual([]);
  });

  it('never sends the API key to the renderer', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().emit({
      type: 'session-error',
      identity: { sessionId: session.id, generation: 1 },
      error: 'boom',
      fatal: false,
    });
    expect(JSON.stringify(env.broadcasts)).not.toContain('sk-test-secret');
  });
});

describe('createAgentHost host calls', () => {
  it('answers orchestration calls with a "not wired" error until a factory is set', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'plan');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({
      type: 'host-invoke',
      identity,
      callId: '1',
      kind: 'orchestration',
      method: 'listWorkers',
      input: undefined,
    });
    await flush();
    expect(env.sent('host-result')).toEqual([
      {
        type: 'host-result',
        identity,
        callId: '1',
        result: { ok: false, error: expect.stringContaining('not wired') },
      },
    ]);
  });

  it('runs orchestration calls on the injected host and cancels them on host-cancel', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'plan');
    let seenSignal: AbortSignal | undefined;
    const host = {
      listWorkers: vi.fn(async () => ({ ok: true as const, workers: [] })),
      waitForWorkers: vi.fn(
        (_input: unknown, signal?: AbortSignal) =>
          new Promise((resolve) => {
            seenSignal = signal;
            signal?.addEventListener('abort', () =>
              resolve({ ok: true, timedOut: true, messages: [], pending: 1 })
            );
          })
      ),
    } as unknown as OrchestrationHost;
    const factory = vi.fn(() => host);
    env.host.setOrchestrationHostFactory(factory);
    const identity = { sessionId: session.id, generation: 1 };

    env.worker().emit({
      type: 'host-invoke',
      identity,
      callId: '1',
      kind: 'orchestration',
      method: 'listWorkers',
      input: undefined,
    });
    await flush();
    expect(factory).toHaveBeenCalledWith(session.id, 'ws-1');
    expect(env.sent('host-result').at(-1)).toEqual({
      type: 'host-result',
      identity,
      callId: '1',
      result: { ok: true, workers: [] },
    });

    env.worker().emit({
      type: 'host-invoke',
      identity,
      callId: '2',
      kind: 'orchestration',
      method: 'waitForWorkers',
      input: { timeoutMs: 60_000, until: 'all' },
    });
    await flush();
    expect(seenSignal?.aborted).toBe(false);
    env.worker().emit({ type: 'host-cancel', identity, callId: '2' });
    await flush();
    expect(seenSignal?.aborted).toBe(true);
    expect(env.sent('host-result').at(-1)).toMatchObject({
      callId: '2',
      result: { ok: true, timedOut: true },
    });
  });

  it('ignores host calls of a stale generation instead of running them', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'plan');
    const factory = vi.fn(() => null);
    env.host.setOrchestrationHostFactory(factory);
    env.worker().emit({
      type: 'host-invoke',
      identity: { sessionId: session.id, generation: 7 },
      callId: '1',
      kind: 'orchestration',
      method: 'dispatchTask',
      input: { title: 't' },
    });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(env.sent('host-result')).toEqual([]);
  });

  it('only gives dispatched worker sessions a worker host', async () => {
    const env = setup();
    const workerHost: WorkerHost = {
      askCoordinator: vi.fn(async () => ({ ok: true as const, answer: 'use sqlite' })),
      reportDone: vi.fn(async () => ({ ok: true as const })),
    };
    env.host.setWorkerHostFactory(() => workerHost);
    const plain = await createSession(env);
    await env.host.prompt(plain.id, 'hi');
    env.worker().emit({
      type: 'host-invoke',
      identity: { sessionId: plain.id, generation: 1 },
      callId: '1',
      kind: 'worker',
      method: 'reportDone',
      input: { outcome: 'succeeded', summary: 's' },
    });
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({ result: { ok: false } });
    expect(workerHost.reportDone).not.toHaveBeenCalled();
  });
});

describe('createAgentHost crash recovery', () => {
  it('interrupts running sessions and re-spawns them with generation + 1 before other commands', async () => {
    let networkProxy: SpawnSessionSpec['networkProxy'];
    const env = setup({ resolveNetworkProxy: () => networkProxy });
    const running = await createSession(env);
    const idle = await createSession(env, 'tester');
    await env.host.prompt(running.id, 'long task');
    await env.host.prompt(idle.id, 'quick');
    env.worker().emit({
      type: 'session-status',
      identity: { sessionId: idle.id, generation: 1 },
      status: 'idle',
    });

    networkProxy = { mode: 'manual', url: 'http://127.0.0.1:7890', gitCompatibility: true };
    env.worker().exit(1);
    expect(env.events(running.id)).toEqual([
      { type: 'error', source: 'host', message: expect.stringContaining('意外退出'), seq: 1 },
      { type: 'agent_settled', aborted: true, seq: 2 },
    ]);
    expect(env.events(idle.id)).toEqual([]);
    expect(env.host.list('ws-1').find((session) => session.id === running.id)?.status).toBe(
      'error'
    );

    await flush();
    expect(env.processes).toHaveLength(2);
    env.worker().emit({ type: 'ready' });
    expect(
      env.sent().map((command) => [command.type, 'identity' in command && command.identity])
    ).toEqual([
      ['spawn-session', { sessionId: running.id, generation: 2 }],
      ['spawn-session', { sessionId: idle.id, generation: 2 }],
    ]);

    for (const spawn of env.sent('spawn-session')) {
      expect(spawn).toMatchObject({ spec: { networkProxy } });
    }
    // 新进程的事件从 seq 1 开始，Renderer 看到的会话级 seq 继续递增
    env.worker().emit({
      type: 'session-event',
      identity: { sessionId: running.id, generation: 2 },
      seq: 1,
      event: { type: 'text_delta', delta: 'back', seq: 1 },
    });
    expect(env.events(running.id).at(-1)).toEqual({ type: 'text_delta', delta: 'back', seq: 3 });
  });

  it('tells the caller to retry while the worker is down', async () => {
    const env = setup({ workerOptions: { restartDelayMs: 10_000 } });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().exit(1);
    env.worker().exit(1);
    expect(await env.host.prompt(session.id, 'while down')).toMatchObject({
      ok: false,
      error: expect.stringContaining('agent worker'),
    });
  });
});

describe('createAgentHost launcher', () => {
  it('creates a worker session, sends the brief and exposes its transcript', async () => {
    const env = setup();
    const launcher = env.host.implementsLauncher();
    const created = await launcher.createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'tester',
      cwd: join(env.dir, 'worktrees', 'ws-1', 'add-tests'),
      worktreeId: 'wt_1',
      brief: '# Add tests for the parser\n\n## Target\n...',
    });
    expect(created).toEqual({ ok: true, sessionId: 'session-1' });
    expect(env.host.list('ws-1')[0]).toMatchObject({
      id: 'session-1',
      roleId: 'tester',
      title: 'Add tests for the parser',
      dispatchId: 'dsp_1',
      worktreeId: 'wt_1',
      cwd: join(env.dir, 'worktrees', 'ws-1', 'add-tests'),
      status: 'running',
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
    });
    const spawn = env.sent('spawn-session')[0];
    expect(spawn?.type === 'spawn-session' && spawn.spec.worker).toBe(true);
    expect(env.sent('prompt')[0]).toMatchObject({
      text: '# Add tests for the parser\n\n## Target\n...',
    });

    const identity = { sessionId: 'session-1', generation: 1 };
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 1,
      event: { type: 'text_delta', delta: 'Writing tests', seq: 1 },
    });
    expect(await launcher.readTranscript('session-1', 0)).toEqual({
      ok: true,
      text: 'Writing tests',
      total: 13,
      done: false,
    });
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(await launcher.readTranscript('session-1', 8)).toEqual({
      ok: true,
      text: 'tests',
      total: 13,
      done: true,
    });

    expect(
      await launcher.promptSession('session-1', 'Review feedback: add edge cases', {
        freshAttempt: true,
      })
    ).toEqual({
      ok: true,
    });
    await launcher.disposeSession('session-1');
    expect(env.sent('dispose-session')).toHaveLength(1);
    expect(env.host.list('ws-1')).toHaveLength(1);
    expect(await launcher.promptSession('missing', 'x')).toMatchObject({ ok: false });
  });

  it('does not leave a session behind when the dispatch cannot start', async () => {
    const env = setup();
    const launcher = env.host.implementsLauncher();
    expect(
      await launcher.createWorkerSession({
        workspaceId: 'ws-1',
        runId: 'r',
        dispatchId: 'd',
        roleId: 'ghost',
        cwd: '/x',
        worktreeId: 'w',
        brief: 'b',
      })
    ).toMatchObject({ ok: false });
    expect(env.host.list('ws-1')).toEqual([]);
  });

  it('makes the coordinator of the run the parent of the worker session', async () => {
    const env = setup();
    const lookup = vi.fn((workspaceId: string, runId: string) =>
      workspaceId === 'ws-1' && runId === 'run_1' ? 'session-coord' : undefined
    );
    env.host.setCoordinatorLookup(lookup);
    const launcher = env.host.implementsLauncher();
    const input = {
      workspaceId: 'ws-1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: '/worktrees/ws-1/a',
      worktreeId: 'wt_1',
      brief: '# A',
    };

    const child = await launcher.createWorkerSession({ ...input, runId: 'run_1' });
    const orphan = await launcher.createWorkerSession({ ...input, runId: 'run_gone' });
    const byId = (result: typeof child) =>
      env.host.list('ws-1').find((session) => result.ok && session.id === result.sessionId);
    expect(byId(child)?.parentSessionId).toBe('session-coord');
    expect(byId(orphan)).not.toHaveProperty('parentSessionId');
    expect(lookup).toHaveBeenCalledWith('ws-1', 'run_1');
  });

  it('keeps the launcher contract the orchestration host relies on', async () => {
    const env = setup();
    const launcher = env.host.implementsLauncher();
    // 1. brief 提交即 resolve：不等 worker 这一轮跑完（Host 在 resolve 后同步写入 Dispatch）
    const created = await launcher.createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: '/worktrees/ws-1/a',
      worktreeId: 'wt_1',
      brief: '# A',
    });
    if (!created.ok) throw new Error(created.error);
    const identity = { sessionId: created.sessionId, generation: 1 };
    expect(env.sent().map((command) => command.type)).toEqual(['spawn-session', 'prompt']);
    expect(env.events(created.sessionId)).toEqual([]);

    // 2. WorkerHost 工厂在 host 调用到达时才查：Dispatch 写入前没有 Host，之后的调用就能拿到
    const reportDone = vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true }));
    const invoke = (callId: string) =>
      env.worker().emit({
        type: 'host-invoke',
        identity,
        callId,
        kind: 'worker',
        method: 'reportDone',
        input: { outcome: 'succeeded', summary: 'done' },
      });
    invoke('1');
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({ callId: '1', result: { ok: false } });
    env.host.setWorkerHostFactory((sessionId) =>
      sessionId === created.sessionId ? { askCoordinator: vi.fn(), reportDone } : null
    );
    invoke('2');
    await flush();
    expect(env.sent('host-result').at(-1)).toMatchObject({ callId: '2', result: { ok: true } });
    expect(reportDone).toHaveBeenCalledWith('succeeded', 'done', undefined);

    // 3. Fresh-attempt feedback starts a new run, reopening report_done after reject_work.
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
    expect(
      await launcher.promptSession(created.sessionId, 'Review feedback', { freshAttempt: true })
    ).toEqual({
      ok: true,
    });
    expect(env.sent('prompt').at(-1)).toEqual({
      type: 'prompt',
      identity,
      text: 'Review feedback',
    });
    expect(env.host.list('ws-1')[0]?.status).toBe('running');
  });
});

describe('createAgentHost approvals', () => {
  const request = (patch: Partial<AgentApprovalRequest> = {}): AgentApprovalRequest => ({
    requestId: 'req-1',
    toolCallId: 'c1',
    toolName: 'edit',
    kind: 'file-edit',
    title: 'edit',
    detail: 'src/a.ts',
    // worker 按自己的时钟算出的到期时间（与 Main 的 now 无关）
    expiresAt: 900_000,
    ...patch,
  });

  /** worker 会话在跑一轮，审批门发出了一个请求（先 approval-request，再 approval_request 事件） */
  async function pending(patch: Partial<AgentApprovalRequest> = {}, setupOverrides = {}) {
    const env = setup(setupOverrides);
    const session = await createSession(env);
    await env.host.prompt(session.id, 'change it');
    const identity = { sessionId: session.id, generation: 1 };
    const announced = request(patch);
    env.worker().emit({ type: 'session-status', identity, status: 'waiting-approval' });
    env.worker().emit({ type: 'approval-request', identity, request: announced });
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 1,
      event: {
        type: 'approval_request',
        requestId: announced.requestId,
        toolCallId: announced.toolCallId,
        toolName: announced.toolName,
        args: { path: 'src/a.ts' },
        seq: 1,
      },
    });
    const respond = (decision: ApprovalDecision, sessionId = session.id) =>
      env.host.respondApproval({ sessionId, requestId: announced.requestId, decision });
    return { ...env, session, identity, respond };
  }

  it('pushes the request with the fields the gate produced and forwards the decision once', async () => {
    const env = await pending();
    expect(env.pushed(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)).toEqual([
      [
        {
          id: 'req-1',
          sessionId: env.session.id,
          kind: 'file-edit',
          title: 'edit',
          detail: 'src/a.ts',
          expiresAt: 900_000,
        },
      ],
    ]);
    // 时间线事件照常转发（Renderer 据 toolCallId 在工具结束时出队），但不再重复推送
    expect(env.events(env.session.id)).toEqual([
      expect.objectContaining({ type: 'approval_request', requestId: 'req-1', toolCallId: 'c1' }),
    ]);

    expect(await env.respond('allow', 'other')).toMatchObject({ ok: false });
    expect(await env.respond('allow')).toEqual({ ok: true });
    expect(env.sent('respond-approval')).toEqual([
      { type: 'respond-approval', identity: env.identity, requestId: 'req-1', decision: 'allow' },
    ]);
    expect(await env.respond('deny')).toMatchObject({ ok: false });
  });

  it('marks a protected action in the title of the approval bar', async () => {
    const env = await pending({
      toolName: 'bash',
      kind: 'command',
      title: 'bash',
      detail: 'git push origin main',
      protectedAction: 'git push',
    });
    expect(env.pushed(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)[0]?.[0]).toMatchObject({
      kind: 'command',
      title: 'bash（保护底线：git push）',
      detail: 'git push origin main',
    });
  });

  it('does not push anything for an approval_request event alone', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'change it');
    env.worker().emit({
      type: 'session-event',
      identity: { sessionId: session.id, generation: 1 },
      seq: 1,
      event: {
        type: 'approval_request',
        requestId: 'req-9',
        toolCallId: 'c9',
        toolName: 'bash',
        args: {},
        seq: 1,
      },
    });
    expect(env.pushed(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)).toEqual([]);
    expect(
      await env.host.respondApproval({
        sessionId: session.id,
        requestId: 'req-9',
        decision: 'allow',
      })
    ).toMatchObject({ ok: false });
  });

  it('ignores approval requests of a stale generation', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'change it');
    env.worker().emit({
      type: 'approval-request',
      identity: { sessionId: session.id, generation: 7 },
      request: request(),
    });
    expect(env.pushed(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)).toEqual([]);
    expect(
      await env.host.respondApproval({
        sessionId: session.id,
        requestId: 'req-1',
        decision: 'allow',
      })
    ).toMatchObject({ ok: false });
  });

  it('refuses an answer after the expiry the worker enforces', async () => {
    let time = 1_000;
    const env = await pending({ expiresAt: 5_000 }, { now: () => time });
    time = 5_000;
    expect(await env.respond('allow')).toEqual({ ok: false, error: '审批请求已过期' });
    expect(env.sent('respond-approval')).toEqual([]);
  });

  it('forgets pending requests immediately on Stop before the worker settles', async () => {
    const env = await pending();
    const stopped = env.host.abort(env.session.id);
    expect(await env.respond('allowSession')).toMatchObject({ ok: false });
    expect(await stopped).toEqual({ ok: true });
    expect(env.sent('respond-approval')).toEqual([]);
  });

  it('forgets pending requests when the turn settles', async () => {
    const env = await pending();
    env.worker().emit({
      type: 'session-event',
      identity: env.identity,
      seq: 2,
      event: { type: 'agent_settled', aborted: false, seq: 2 },
    });
    expect(await env.respond('allow')).toMatchObject({ ok: false });
  });

  it('denies pending requests when the worker crashes', async () => {
    const env = await pending();
    env.worker().exit(1);
    expect(await env.respond('allow')).toMatchObject({ ok: false });
    // 进行中的回合按中止收尾：Renderer 据 agent_settled 清空审批条
    expect(env.events(env.session.id).at(-1)).toMatchObject({
      type: 'agent_settled',
      aborted: true,
    });
  });

  it('ends the turn and clears pending requests when a waiting session is disposed', async () => {
    const env = await pending();
    await env.host.implementsLauncher().disposeSession(env.session.id);
    expect(env.sent('dispose-session')).toEqual([
      { type: 'dispose-session', identity: env.identity },
    ]);
    expect(await env.respond('allow')).toMatchObject({ ok: false });
    expect(env.events(env.session.id).at(-1)).toMatchObject({
      type: 'agent_settled',
      aborted: true,
    });
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
  });

  it('leaves an idle session quiet when it is disposed', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    await env.host.implementsLauncher().disposeSession(session.id);
    expect(env.events(session.id)).toEqual([]);
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
  });
});

describe('createAgentHost model choice', () => {
  const openai: StoredProvider = {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-responses',
    enabled: true,
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    apiKey: 'sk-openai-secret',
  };
  const local: StoredProvider = {
    id: 'local',
    name: 'Local vLLM',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    enabled: true,
    // 自定义 OpenAI 兼容服务：pi 目录里没有这个模型，是否推理看设置里的标记
    models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', reasoning: true }],
    apiKey: 'local-key',
  };
  const disabled: StoredProvider = { ...openai, id: 'old-openai', name: 'Old', enabled: false };
  const keyless: StoredProvider = { ...openai, id: 'keyless', name: 'No key', apiKey: undefined };
  const catalog = [anthropic, openai, local, disabled, keyless];
  const OPENAI_RUNTIME = runtimeProviderId('https://api.openai.com/v1', 'sk-openai-secret');

  /** 假 worker 的回答：pi 1.4.0 目录给这些模型的档位 */
  const CAPABILITIES: Record<string, ModelThinkingCapability> = {
    'claude-sonnet-5-5': {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    },
    'claude-haiku-5-5': {
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    },
    'gpt-5.5': {
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    },
    'qwen3-coder': {
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      defaultThinking: 'medium',
    },
  };
  const describeLikePi = (query: ModelQuery): ModelThinkingCapability =>
    CAPABILITIES[query.modelId] ?? { thinkingLevels: [] };

  const architect: Role = {
    ...tester,
    id: 'architect',
    name: 'Architect',
    model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5', thinking: 'off' },
  };

  function modelEnv(overrides: Partial<AgentHostDeps> = {}) {
    const remembered: [string, SessionModelRef][] = [];
    const env = setup({
      models: modelsOf(catalog),
      providers: { list: async () => catalog.map(toProviderView) },
      lastModels: {
        get: (workspaceId) => remembered.filter(([id]) => id === workspaceId).at(-1)?.[1],
        set: (workspaceId, model) => {
          remembered.push([workspaceId, model]);
        },
      },
      roles: {
        get: async (id) => getBuiltinRole(id) ?? [tester, architect].find((role) => role.id === id),
        list: async () => [...BUILTIN_ROLES, tester, architect],
      },
      ...overrides,
    });
    /** 回答最近一条 describe-models */
    const answerDescribe = () => {
      const command = env.sent('describe-models').at(-1);
      if (command?.type !== 'describe-models') throw new Error('no describe-models was sent');
      env.worker().emit({
        type: 'models-described',
        requestId: command.requestId,
        result: { ok: true, models: command.models.map(describeLikePi) },
      });
    };
    const modelOptions = async (workspaceId?: string) => {
      const before = env.sent('describe-models').length;
      const pending = env.host.modelOptions(workspaceId ? { workspaceId } : {});
      await flush();
      if (env.sent('describe-models').length > before) answerDescribe();
      return pending;
    };
    return { ...env, remembered, modelOptions };
  }

  const specModel = (command: AgentCommand | undefined) =>
    command?.type === 'spawn-session' ? command.spec.model : undefined;

  it('lists enabled providers with a key, with the thinking levels the worker gives per model', async () => {
    const env = modelEnv();
    const options = await env.modelOptions('ws-1');
    expect(env.sent('describe-models')).toEqual([
      {
        type: 'describe-models',
        requestId: expect.any(String),
        models: [
          { api: 'anthropic-messages', modelId: 'claude-sonnet-5-5' },
          { api: 'anthropic-messages', modelId: 'claude-haiku-5-5' },
          { api: 'openai-responses', modelId: 'gpt-5.5' },
          { api: 'openai-completions', modelId: 'qwen3-coder', reasoning: true },
        ],
      },
    ]);
    expect(options).toEqual({
      ok: true,
      providers: [
        {
          providerId: 'anthropic',
          name: 'Anthropic',
          api: 'anthropic-messages',
          models: [
            {
              id: 'claude-sonnet-5-5',
              name: 'Claude Sonnet 5.5',
              ...CAPABILITIES['claude-sonnet-5-5'],
            },
            {
              id: 'claude-haiku-5-5',
              name: 'Claude Haiku 5.5',
              ...CAPABILITIES['claude-haiku-5-5'],
            },
          ],
        },
        {
          providerId: 'openai',
          name: 'OpenAI',
          api: 'openai-responses',
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5', ...CAPABILITIES['gpt-5.5'] }],
        },
        {
          providerId: 'local',
          name: 'Local vLLM',
          api: 'openai-completions',
          models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', ...CAPABILITIES['qwen3-coder'] }],
        },
      ],
    });
    // 不带 key、地址
    expect(JSON.stringify(options)).not.toMatch(/sk-|local-key|127\.0\.0\.1/);

    // pi 目录随 worker 固定：第二次直接用缓存，不再问 worker
    expect(await env.host.modelOptions({})).toEqual(options);
    expect(env.sent('describe-models')).toHaveLength(1);
  });

  it('returns the model last used in the workspace', async () => {
    const env = modelEnv();
    const model: SessionModelRef = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' };
    await env.host.create({ workspaceId: 'ws-1', roleId: 'worker', model });
    expect(env.remembered).toEqual([['ws-1', model]]);
    expect(await env.modelOptions('ws-1')).toMatchObject({ ok: true, lastUsed: model });
    expect(await env.host.modelOptions({ workspaceId: 'ws-2' })).not.toHaveProperty('lastUsed');
  });

  it('reports a worker that cannot answer instead of hanging', async () => {
    const env = modelEnv({ describeTimeoutMs: 20 });
    expect(await env.host.modelOptions({})).toEqual({
      ok: false,
      error: expect.stringContaining('超时'),
    });

    const failed = env.host.modelOptions({});
    await flush();
    const command = env.sent('describe-models').at(-1);
    if (command?.type !== 'describe-models') throw new Error('no describe-models');
    env.worker().emit({
      type: 'models-described',
      requestId: command.requestId,
      result: { ok: false, error: 'the model catalog failed to load' },
    });
    expect(await failed).toEqual({ ok: false, error: 'the model catalog failed to load' });

    const crashed = env.host.modelOptions({});
    await flush();
    env.worker().exit(1);
    expect(await crashed).toEqual({ ok: false, error: expect.stringContaining('退出') });
  });

  it('creates a session with the chosen model and thinking level and spawns it with them', async () => {
    const env = modelEnv();
    const created = await env.host.create({
      workspaceId: 'ws-1',
      roleId: 'worker',
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' },
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.session.model).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    });
    await env.host.prompt(created.session.id, 'hi');
    expect(specModel(env.sent('spawn-session')[0])).toEqual({
      providerId: OPENAI_RUNTIME,
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-secret',
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    });
  });

  it("falls back to the role's model and thinking level when none is chosen", async () => {
    const env = modelEnv();
    const created = await env.host.create({ workspaceId: 'ws-1', roleId: 'architect' });
    expect(created.ok && created.session.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku-5-5',
      thinking: 'off',
    });
  });

  it('carries the reasoning mark of a custom model into the spawn spec', async () => {
    const env = modelEnv();
    const created = await env.host.create({
      workspaceId: 'ws-1',
      roleId: 'worker',
      model: { providerId: 'local', modelId: 'qwen3-coder', thinking: 'high' },
    });
    if (!created.ok) throw new Error(created.error);
    await env.host.prompt(created.session.id, 'hi');
    expect(specModel(env.sent('spawn-session')[0])).toMatchObject({
      modelId: 'qwen3-coder',
      reasoning: true,
      thinking: 'high',
    });
  });

  it('switches a session that is not in the worker yet: the record now, the spawn later', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    env.broadcasts.length = 0;
    const model: SessionModelRef = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'high' };

    const switched = await env.host.setModel({ sessionId: session.id, model });
    expect(switched).toEqual({ ok: true, session: { ...session, model } });
    expect(env.host.list('ws-1')[0]?.model).toEqual(model);
    expect(env.pushed(IPC_CHANNELS.SESSIONS_CHANGED)).toEqual([['ws-1']]);
    expect(env.sent()).toEqual([]);
    expect(env.remembered.at(-1)).toEqual(['ws-1', model]);
    // sessions.json 落盘的也是新模型
    expect(env.store.flush()).toBe(true);
    const file = JSON.parse(readFileSync(join(env.dir, 'sessions.json'), 'utf8'));
    expect(file.sessions[0].model).toEqual(model);

    await env.host.prompt(session.id, 'hi');
    expect(specModel(env.sent('spawn-session')[0])).toMatchObject({
      providerId: OPENAI_RUNTIME,
      modelId: 'gpt-5.5',
      thinking: 'high',
    });
  });

  it('sends set-model to the worker and keeps the new model for a crash respawn', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'first');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });

    const model: SessionModelRef = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' };
    expect(await env.host.setModel({ sessionId: session.id, model })).toMatchObject({ ok: true });
    const openaiSpec = {
      providerId: OPENAI_RUNTIME,
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-secret',
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    };
    expect(env.sent('set-model')).toEqual([{ type: 'set-model', identity, model: openaiSpec }]);

    env.worker().exit(1);
    await flush();
    env.worker().emit({ type: 'ready' });
    expect(specModel(env.sent('spawn-session')[0])).toEqual(openaiSpec);
  });

  it('rebuilds a crashed session with the model chosen while the worker restarted', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'first');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    env.worker().exit(1);
    // worker 还没重启：只改记录和缓存的 spec；重建不能沿用崩溃前缓存的旧模型
    const model: SessionModelRef = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' };
    expect(await env.host.setModel({ sessionId: session.id, model })).toMatchObject({ ok: true });
    expect(env.sent('set-model')).toEqual([]);
    await flush();
    env.worker().emit({ type: 'ready' });
    expect(specModel(env.sent('spawn-session').at(-1))).toMatchObject({
      providerId: OPENAI_RUNTIME,
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    });
  });

  it('refuses to switch while the session is running or a prompt is on its way', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    const model = { providerId: 'openai', modelId: 'gpt-5.5' };
    const refused = { ok: false, error: expect.stringContaining('等本轮结束') };

    // 换模型还在解析时开始了一轮：解析完再查一次，不能让刚 spawn 的会话与记录对不上
    const switching = env.host.setModel({ sessionId: session.id, model });
    const inFlight = env.host.prompt(session.id, 'first');
    expect(await switching).toEqual(refused);
    expect(await env.host.setModel({ sessionId: session.id, model })).toEqual(refused);
    await inFlight;
    expect(await env.host.setModel({ sessionId: session.id, model })).toEqual(refused);
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'waiting-approval' });
    expect(await env.host.setModel({ sessionId: session.id, model })).toEqual(refused);

    expect(env.sent('set-model')).toEqual([]);
    expect(env.host.list('ws-1')[0]?.model).toEqual(session.model);
  });

  it('returns a readable error and changes nothing when the model cannot be resolved', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    env.broadcasts.length = 0;
    const attempt = (providerId: string, modelId: string) =>
      env.host.setModel({ sessionId: session.id, model: { providerId, modelId } });

    expect(await attempt('ghost', 'x')).toEqual({
      ok: false,
      error: expect.stringContaining('不存在'),
    });
    expect(await attempt('old-openai', 'gpt-5.5')).toEqual({
      ok: false,
      error: expect.stringContaining('已停用'),
    });
    expect(await attempt('openai', 'gpt-9')).toEqual({
      ok: false,
      error: expect.stringContaining('没有模型'),
    });
    expect(await attempt('keyless', 'gpt-5.5')).toEqual({
      ok: false,
      error: expect.stringContaining('API Key'),
    });
    const ghostSession = await env.host.setModel({
      sessionId: 'ghost',
      model: { providerId: 'openai', modelId: 'gpt-5.5' },
    });
    expect(ghostSession).toEqual({ ok: false, error: '会话不存在' });

    expect(env.host.list('ws-1')[0]).toEqual(session);
    expect(env.broadcasts).toEqual([]);
    expect(env.sent()).toEqual([]);
    expect(env.remembered).toEqual([['ws-1', session.model]]);
  });

  it('clears an error status when the model is switched', async () => {
    const env = modelEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'error' });
    expect(env.host.list('ws-1')[0]?.status).toBe('error');
    await env.host.setModel({
      sessionId: session.id,
      model: { providerId: 'openai', modelId: 'gpt-5.5' },
    });
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
  });

  it("gives a dispatched worker its role's model, or the orchestrator's current model", async () => {
    const env = modelEnv();
    const coordinator = await env.host.create({
      workspaceId: 'ws-1',
      roleId: 'orchestrator',
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' },
    });
    if (!coordinator.ok) throw new Error(coordinator.error);
    env.host.setCoordinatorLookup(() => coordinator.session.id);
    const launcher = env.host.implementsLauncher();
    const dispatch = async (roleId: string) => {
      const created = await launcher.createWorkerSession({
        workspaceId: 'ws-1',
        runId: 'run_1',
        dispatchId: `dsp_${roleId}`,
        roleId,
        cwd: '/worktrees/ws-1/a',
        worktreeId: 'wt_1',
        brief: '# A',
      });
      if (!created.ok) throw new Error(created.error);
      return env.host.list('ws-1').find((session) => session.id === created.sessionId);
    };

    // 角色没配模型：继承主 agent 当前的模型与档位
    expect((await dispatch('worker'))?.model).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    });
    // 角色配了模型：用角色的
    expect((await dispatch('architect'))?.model).toEqual(architect.model);

    // 主 agent 换了模型之后派出的 worker 跟着换
    const sonnet: SessionModelRef = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      thinking: 'high',
    };
    expect(
      await env.host.setModel({ sessionId: coordinator.session.id, model: sonnet })
    ).toMatchObject({ ok: true });
    const worker = await dispatch('tester');
    expect(worker?.model).toEqual(sonnet);

    // 派发出的会话不算「这个工作区上一次用过的模型」
    const remembered = env.remembered.length;
    env.worker().emit({
      type: 'session-status',
      identity: { sessionId: worker?.id ?? '', generation: 1 },
      status: 'idle',
    });
    expect(
      await env.host.setModel({
        sessionId: worker?.id ?? '',
        model: { providerId: 'openai', modelId: 'gpt-5.5' },
      })
    ).toMatchObject({ ok: true });
    expect(env.remembered).toHaveLength(remembered);
  });

  it('档位会话：指定模型生效、不可用时报错；默认模型同不指定时', async () => {
    const env = modelEnv();
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const create = (model?: SessionModelRef) =>
      env.host.createProfileSession({
        workspaceId: 'ws-1',
        profile: 'triage',
        cwd: env.workspace.repoPath,
        ...(model ? { model } : {}),
      });
    expect(await create({ providerId: 'openai', modelId: 'gpt-5.5' })).toMatchObject({
      ok: true,
      session: { model: { providerId: 'openai', modelId: 'gpt-5.5' } },
    });
    for (const model of [
      { providerId: 'old-openai', modelId: 'gpt-5.5' },
      { providerId: 'keyless', modelId: 'gpt-5.5' },
      { providerId: 'openai', modelId: 'nope' },
    ]) {
      expect((await create(model)).ok).toBe(false);
    }
    const plain = await create();
    if (!plain.ok) throw new Error(plain.error);
    for (const profile of ['triage', 'restricted'] as const) {
      expect(await env.host.profileDefaultModel(profile)).toEqual({
        ok: true,
        model: plain.session.model,
      });
    }
  });

  it('档位会话：带思考档位时记录里有它；checkThinking 只放行模型支持的档位', async () => {
    const env = modelEnv();
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const ref = { providerId: 'openai', modelId: 'gpt-5.5' };
    // 假 worker 要回答 describe-models（做法同 modelOptions）
    const check = async (thinking: ThinkingLevel) => {
      const pending = env.host.checkThinking(ref, thinking);
      await flush();
      const command = env.sent('describe-models').at(-1);
      if (command?.type === 'describe-models') {
        env.worker().emit({
          type: 'models-described',
          requestId: command.requestId,
          result: { ok: true, models: command.models.map(describeLikePi) },
        });
      }
      return pending;
    };
    expect(await check('high')).toEqual({ ok: true });
    expect((await check('max')).ok).toBe(false);
    const created = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'triage',
      cwd: env.workspace.repoPath,
      model: { ...ref, thinking: 'high' },
    });
    if (!created.ok) throw new Error(created.error);
    expect(env.store.get(created.session.id)?.model).toMatchObject({ ...ref, thinking: 'high' });
    await env.host.setModel({ sessionId: created.session.id, model: { ...ref, thinking: 'low' } });
    expect(env.store.get(created.session.id)?.model).toMatchObject({ ...ref, thinking: 'low' });
  });

  it('restricted 协调者派出的 worker 跟主会话模型，普通协调者仍优先角色模型', async () => {
    const env = modelEnv();
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const duty = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'restricted',
      cwd: env.workspace.repoPath,
      model: { providerId: 'openai', modelId: 'gpt-5.5' },
    });
    if (!duty.ok) throw new Error(duty.error);
    const plain = await env.host.create({ workspaceId: 'ws-1', roleId: 'orchestrator' });
    if (!plain.ok) throw new Error(plain.error);
    let parent = duty.session.id;
    env.host.setCoordinatorLookup(() => parent);
    const launcher = env.host.implementsLauncher();
    const dispatch = async (dispatchId: string) => {
      const created = await launcher.createWorkerSession({
        workspaceId: 'ws-1',
        runId: 'run_1',
        dispatchId,
        roleId: 'architect',
        cwd: '/worktrees/ws-1/a',
        brief: '# A',
      });
      if (!created.ok) throw new Error(created.error);
      return env.store.get(created.sessionId)?.model;
    };
    expect(await dispatch('dsp_1')).toEqual({ providerId: 'openai', modelId: 'gpt-5.5' });
    parent = plain.session.id;
    expect(await dispatch('dsp_2')).toEqual(architect.model);
  });

  it('lets dispatch_task pick the model and thinking level over the role and the coordinator', async () => {
    const astra: StoredProvider = {
      ...openai,
      id: 'astra',
      name: 'Astra',
      models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
      apiKey: 'sk-astra-secret',
    };
    const providers = [...catalog, astra];
    const env = modelEnv({
      models: modelsOf(providers),
      providers: { list: async () => providers.map(toProviderView) },
    });
    const coordinator = await env.host.create({
      workspaceId: 'ws-1',
      roleId: 'orchestrator',
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' },
    });
    if (!coordinator.ok) throw new Error(coordinator.error);
    env.host.setCoordinatorLookup(() => coordinator.session.id);
    const launcher = env.host.implementsLauncher();
    const astraLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    let seq = 0;
    const dispatch = async (
      extra: { model?: string; thinking?: SessionModelRef['thinking'] },
      roleId = 'architect'
    ) => {
      const pending = launcher.createWorkerSession({
        workspaceId: 'ws-1',
        runId: 'run_1',
        dispatchId: `dsp_${++seq}`,
        roleId,
        cwd: '/worktrees/ws-1/a',
        worktreeId: 'wt_1',
        brief: '# A',
        ...extra,
      });
      // thinking is checked against the levels the worker reports for the model
      const before = env.sent('describe-models').length;
      await flush();
      const command = env.sent('describe-models').at(-1);
      if (env.sent('describe-models').length > before && command?.type === 'describe-models') {
        env.worker().emit({
          type: 'models-described',
          requestId: command.requestId,
          result: {
            ok: true,
            models: command.models.map((query) =>
              query.modelId === 'gpt-6-astra'
                ? { thinkingLevels: [...astraLevels], defaultThinking: 'medium' }
                : describeLikePi(query)
            ),
          },
        });
      }
      const created = await pending;
      if (!created.ok) return created;
      return env.host.list('ws-1').find((session) => session.id === created.sessionId);
    };

    // explicit model + thinking beat the role's model
    expect(await dispatch({ model: 'GPT-6-Astra', thinking: 'max' })).toMatchObject({
      model: { providerId: 'astra', modelId: 'gpt-6-astra', thinking: 'max' },
    });
    // providerId/modelId form; no thinking = the model's default
    const qualified = await dispatch({ model: 'openai/gpt-5.5' });
    expect(qualified && 'model' in qualified ? qualified.model : qualified).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
    });
    // only thinking: applied to the role's model
    expect(await dispatch({ thinking: 'high' })).toMatchObject({
      model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5', thinking: 'high' },
    });
    // only thinking, no role model: applied to the coordinator's model
    expect(await dispatch({ thinking: 'low' }, 'worker')).toMatchObject({
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'low' },
    });

    const sessions = env.host.list('ws-1').length;
    const unknown = await dispatch({ model: 'gpt-7' });
    expect(unknown).toEqual({
      ok: false,
      error: expect.stringMatching(/unknown model "gpt-7"; available: .*astra\/gpt-6-astra/),
    });
    // disabled / keyless providers are not offered, keys never show up
    expect(JSON.stringify(unknown)).not.toMatch(/old-openai|keyless|sk-/);
    expect(await dispatch({ model: 'gpt-6-astra', thinking: 'minimal' })).toEqual({
      ok: false,
      error: expect.stringContaining('supported: low, medium, high, xhigh, max'),
    });
    expect(env.host.list('ws-1')).toHaveLength(sessions);
  });

  it('reports an ambiguous model id with the providerId/modelId options', async () => {
    const twin: StoredProvider = { ...openai, id: 'openai-2', name: 'OpenAI 2' };
    const providers = [...catalog, twin];
    const env = modelEnv({
      models: modelsOf(providers),
      providers: { list: async () => providers.map(toProviderView) },
    });
    const created = await env.host.implementsLauncher().createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: '/worktrees/ws-1/a',
      worktreeId: 'wt_1',
      brief: '# A',
      model: 'gpt-5.5',
    });
    expect(created).toEqual({
      ok: false,
      error:
        'model "gpt-5.5" is ambiguous; use providerId/modelId: openai/gpt-5.5, openai-2/gpt-5.5',
    });
  });
});

describe('createAgentHost approval mode', () => {
  const spawnRole = (command: AgentCommand | undefined) =>
    command?.type === 'spawn-session' ? command.spec.role : undefined;

  it('switches a session that is not in the worker yet: the record now, the spawn later', async () => {
    const env = setup();
    const session = await createSession(env);
    env.broadcasts.length = 0;

    const switched = await env.host.setApprovalMode({ sessionId: session.id, mode: 'supervised' });
    expect(switched).toEqual({ ok: true, session: { ...session, approvalMode: 'supervised' } });
    expect(env.host.list('ws-1')[0]?.approvalMode).toBe('supervised');
    expect(env.pushed(IPC_CHANNELS.SESSIONS_CHANGED)).toEqual([['ws-1']]);
    expect(env.sent()).toEqual([]);
    expect(env.store.flush()).toBe(true);
    const file = JSON.parse(readFileSync(join(env.dir, 'sessions.json'), 'utf8'));
    expect(file.sessions[0].approvalMode).toBe('supervised');

    // spawn 时审批门按会话的档位建（角色的其余设置不变）
    await env.host.prompt(session.id, 'hi');
    expect(spawnRole(env.sent('spawn-session')[0])).toEqual({
      ...getBuiltinRole('worker'),
      approvalMode: 'supervised',
    });
  });

  it('carries confirmDangerousActions in the spawn spec and pushes changes to live sessions', async () => {
    let confirm = true;
    const env = setup({ resolveConfirmDangerousActions: () => confirm });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    const spawned = env.sent('spawn-session')[0];
    expect(spawned?.type === 'spawn-session' && spawned.spec.confirmDangerousActions).toBe(true);

    confirm = false;
    env.host.setConfirmDangerousActions(false);
    expect(env.sent('set-confirm-dangerous-actions')).toEqual([
      {
        type: 'set-confirm-dangerous-actions',
        identity: { sessionId: session.id, generation: 1 },
        enabled: false,
      },
    ]);
  });

  it('switches a running session at once and keeps the mode for a crash respawn', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'long task');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({ type: 'session-status', identity, status: 'running' });
    expect(spawnRole(env.sent('spawn-session')[0])?.approvalMode).toBe('full');

    // 与换模型不同：运行中也可以切，即时生效
    expect(await env.host.setApprovalMode({ sessionId: session.id, mode: 'supervised' })).toEqual({
      ok: true,
      session: expect.objectContaining({ approvalMode: 'supervised', status: 'running' }),
    });
    env.worker().emit({ type: 'session-status', identity, status: 'waiting-approval' });
    expect(
      await env.host.setApprovalMode({ sessionId: session.id, mode: 'auto-edits' })
    ).toMatchObject({ ok: true });
    expect(env.sent('set-approval-mode')).toEqual([
      { type: 'set-approval-mode', identity, mode: 'supervised' },
      { type: 'set-approval-mode', identity, mode: 'auto-edits' },
    ]);
    expect(env.host.list('ws-1')[0]?.status).toBe('waiting-approval');

    env.worker().exit(1);
    await flush();
    env.worker().emit({ type: 'ready' });
    expect(spawnRole(env.sent('spawn-session')[0])?.approvalMode).toBe('auto-edits');
  });

  it('rebuilds a session that crashed with the mode chosen while the worker restarted', async () => {
    const env = setup();
    const session = await createSession(env, 'orchestrator');
    await env.host.prompt(session.id, 'long task');
    env.worker().exit(1);
    // worker 还没起来：会话不在 worker 里，只改记录；但重建不能沿用崩溃前缓存的 full
    expect(await env.host.setApprovalMode({ sessionId: session.id, mode: 'supervised' })).toEqual({
      ok: true,
      session: expect.objectContaining({ approvalMode: 'supervised' }),
    });
    await flush();
    env.worker().emit({ type: 'ready' });
    expect(spawnRole(env.sent('spawn-session')[0])?.approvalMode).toBe('supervised');
    expect(env.sent('set-approval-mode')).toEqual([]);
  });

  it('leaves everything alone when the mode does not change', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.broadcasts.length = 0;
    expect(await env.host.setApprovalMode({ sessionId: session.id, mode: 'auto-edits' })).toEqual({
      ok: true,
      session: expect.objectContaining({ approvalMode: 'auto-edits' }),
    });
    expect(env.sent('set-approval-mode')).toEqual([]);
    expect(env.broadcasts).toEqual([]);
  });

  it('refuses an unknown session', async () => {
    const env = setup();
    expect(await env.host.setApprovalMode({ sessionId: 'ghost', mode: 'full' })).toEqual({
      ok: false,
      error: '会话不存在',
    });
  });
});

describe('createAgentHost branches', () => {
  /** 注入真实的分支缓存，读分支换成假的（目录 → 分支），时钟可拨 */
  function branchEnv() {
    const checkedOut: Record<string, string | undefined> = {};
    let time = 50_000;
    const read = vi.fn(async (cwd: string) => checkedOut[cwd]);
    const env = setup({ branches: createBranchTracker({ read, now: () => time }) });
    checkedOut[env.workspace.repoPath] = 'main';
    const changes = () => env.pushed(IPC_CHANNELS.SESSIONS_CHANGED).length;
    return {
      ...env,
      checkedOut,
      read,
      changes,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  it('lists sessions with the branch of their cwd, read in the background and announced once', async () => {
    const env = branchEnv();
    const session = await createSession(env);
    const before = env.changes();

    // 第一次列表时还没读过：先不带分支，后台读到后广播 sessions:changed，Renderer 重拉
    expect(env.host.list('ws-1')[0]).not.toHaveProperty('branch');
    expect(env.read).toHaveBeenCalledWith(env.workspace.repoPath);
    await flush();
    expect(env.changes()).toBe(before + 1);
    expect(env.host.list('ws-1')[0]).toEqual({ ...session, branch: 'main' });
    // 重拉落在节流窗口里，读到的也没变：不再广播，不会循环
    await flush();
    expect(env.changes()).toBe(before + 1);
    expect(env.read).toHaveBeenCalledTimes(1);

    // 之后各操作回给 Renderer 的会话也带上分支
    const switched = await env.host.setApprovalMode({ sessionId: session.id, mode: 'full' });
    expect(switched).toMatchObject({ ok: true, session: { branch: 'main', approvalMode: 'full' } });
    expect(await createSession(env, 'tester')).toMatchObject({ branch: 'main' });
  });

  it('sees a checkout made outside on the next list after the throttle window', async () => {
    const env = branchEnv();
    await createSession(env);
    env.host.list('ws-1');
    await flush();
    const before = env.changes();

    env.checkedOut[env.workspace.repoPath] = 'test';
    env.advance(BRANCH_REFRESH_THROTTLE_MS - 1);
    expect(env.host.list('ws-1')[0]?.branch).toBe('main');
    await flush();
    expect(env.changes()).toBe(before);

    env.advance(1);
    env.host.list('ws-1');
    await flush();
    expect(env.changes()).toBe(before + 1);
    expect(env.host.list('ws-1')[0]?.branch).toBe('test');
  });

  it('re-reads when history is loaded and when the window gets the focus again', async () => {
    const env = branchEnv();
    const session = await createSession(env);
    await env.host.history(session.id);
    expect(env.read).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.host.list('ws-1')[0]?.branch).toBe('main');

    // 用户在外面切到了 detached HEAD；窗口重新获得焦点时重读读过的目录（同样节流）
    env.checkedOut[env.workspace.repoPath] = 'a1b2c3d';
    env.host.refreshBranches();
    expect(env.read).toHaveBeenCalledTimes(1);
    env.advance(BRANCH_REFRESH_THROTTLE_MS);
    const before = env.changes();
    env.host.refreshBranches();
    await flush();
    expect(env.changes()).toBe(before + 1);
    expect(env.host.list('ws-1')[0]?.branch).toBe('a1b2c3d');
  });

  it('does not re-read the cwd of an archived session on list or focus', async () => {
    const env = branchEnv();
    const session = await createSession(env);
    env.store.update(session.id, { archivedAt: 1 });
    env.read.mockClear();
    env.advance(BRANCH_REFRESH_THROTTLE_MS);
    env.host.list('ws-1');
    env.host.refreshBranches();
    await flush();
    expect(env.read).not.toHaveBeenCalled();
  });

  it('re-reads once the turn settles, even inside the throttle window (the agent may have checked out)', async () => {
    const env = branchEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'switch to a new branch');
    env.host.list('ws-1');
    await flush();
    const before = env.changes();

    env.checkedOut[env.workspace.repoPath] = 'feature/new';
    env.worker().emit({
      type: 'session-event',
      identity: { sessionId: session.id, generation: 1 },
      seq: 1,
      event: { type: 'agent_settled', aborted: false, seq: 1 },
    });
    await flush();
    expect(env.changes()).toBe(before + 1);
    expect(env.host.list('ws-1')[0]?.branch).toBe('feature/new');
  });

  it('gives a dispatched worker session the branch of its own worktree', async () => {
    const env = branchEnv();
    const coordinator = await createSession(env, 'orchestrator');
    env.checkedOut['/worktrees/ws-1/add-tests'] = 'fynvra/add-tests';
    const created = await env.host.implementsLauncher().createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: '/worktrees/ws-1/add-tests',
      worktreeId: 'wt_1',
      brief: '# Add tests',
    });
    if (!created.ok) throw new Error(created.error);
    env.host.list('ws-1');
    await flush();
    const branchOf = (id: string) =>
      env.host.list('ws-1').find((session) => session.id === id)?.branch;
    expect(branchOf(created.sessionId)).toBe('fynvra/add-tests');
    expect(branchOf(coordinator.id)).toBe('main');
  });
});

describe('titleFrom', () => {
  it.each([
    ['## Fix the build\nmore', 'Fix the build'],
    ['\n\n  - list   item  ', 'list item'],
    ['', ''],
    ['x'.repeat(80), `${'x'.repeat(59)}…`],
    [appendChatFiles('', [{ name: 'a.md', text: '# A' }]), ''],
    [appendChatFiles('## 修复构建\nmore', [{ name: 'a.md', text: '# A' }]), '修复构建'],
  ])('%j → %j', (text, title) => {
    expect(titleFrom(text)).toBe(title);
  });
});

describe('automatic model limits', () => {
  function limitsEnv(contextWindow?: number) {
    const providers: StoredProvider[] = [
      {
        ...anthropic,
        models: [
          {
            id: 'claude-sonnet-5-5',
            name: 'Claude Sonnet 5.5',
            ...(contextWindow ? { contextWindow } : {}),
          },
        ],
      },
    ];
    const probed = Promise.withResolvers<boolean>();
    const modelLimits = {
      ensure: vi.fn(() => probed.promise),
      learn: vi.fn(async (_providerId: string, _modelId: string, _message: string) => false),
      learnMaxOutput: vi.fn(
        async (_providerId: string, _modelId: string, _maxOutput: number) => false
      ),
    };
    const env = setup({ models: modelsOf(providers), modelLimits });
    return { env, providers, probed, modelLimits };
  }
  const identityOf = (sessionId: string) => ({ sessionId, generation: 1 });
  function settle(env: ReturnType<typeof setup>, sessionId: string, seq: number) {
    const identity = identityOf(sessionId);
    env.worker().emit({
      type: 'session-event',
      identity,
      seq,
      event: { type: 'agent_settled', aborted: false, seq },
    });
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
  }
  const spawnedModel = (env: ReturnType<typeof setup>) =>
    (env.sent('spawn-session')[0] as { spec: SpawnSessionSpec }).spec.model;
  function report(
    env: ReturnType<typeof setup>,
    sessionId: string,
    seq: number,
    windowSource: 'settings' | 'catalog' | 'estimated'
  ) {
    const snapshot = {
      configuredStrategy: 'native',
      effectiveStrategy: 'native',
      compactionTimeoutMs: 600000,
      context: { tokens: null, contextWindow: 128000, source: 'unknown', windowSource },
      recoveryRequired: false,
      pendingPromptCount: 0,
    } as const;
    env.worker().emit({
      type: 'session-event',
      identity: identityOf(sessionId),
      seq,
      event: { type: 'context_runtime', snapshot, seq },
    });
  }

  it('probes when the worker reports an estimated window and pushes it to the idle session', async () => {
    const { env, providers, probed, modelLimits } = limitsEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    expect(modelLimits.ensure).not.toHaveBeenCalled();
    report(env, session.id, 1, 'estimated');
    expect(modelLimits.ensure).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5-5');
    settle(env, session.id, 2);
    const model = providers[0]?.models[0];
    if (model) model.contextWindow = 1_000_000;
    probed.resolve(true);
    await vi.waitFor(() => expect(env.sent('set-model')).toHaveLength(1));
    expect(env.sent('set-model')[0]).toMatchObject({
      identity: identityOf(session.id),
      model: { ...spawnedModel(env), contextWindow: 1_000_000 },
    });
  });

  it('waits for the running turn to settle before pushing', async () => {
    const { env, providers, probed } = limitsEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    report(env, session.id, 1, 'estimated');
    const model = providers[0]?.models[0];
    if (model) model.contextWindow = 1_000_000;
    probed.resolve(true);
    await flush();
    await flush();
    expect(env.sent('set-model')).toHaveLength(0);
    settle(env, session.id, 2);
    expect(env.sent('set-model')[0]).toMatchObject({ model: { contextWindow: 1_000_000 } });
  });

  it('does not probe a catalog window', async () => {
    const { env, modelLimits } = limitsEnv();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    report(env, session.id, 1, 'catalog');
    expect(env.sent('spawn-session')).toHaveLength(1);
    expect(modelLimits.ensure).not.toHaveBeenCalled();
  });

  it('probes a settings window too: the entry may lack the max output', async () => {
    const { env, modelLimits } = limitsEnv(200_000);
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    report(env, session.id, 1, 'settings');
    expect(modelLimits.ensure).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5-5');
  });

  it('persists the max output the worker learned from a silent retry and pushes it', async () => {
    const { env, providers, modelLimits } = limitsEnv(200_000);
    modelLimits.learnMaxOutput.mockImplementation(async () => {
      const model = providers[0]?.models[0];
      if (model) model.maxOutput = 131_072;
      return true;
    });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().emit({
      type: 'model-limits-learned',
      identity: identityOf(session.id),
      modelId: 'claude-sonnet-5-5',
      maxOutput: 131_072,
    });
    expect(modelLimits.learnMaxOutput).toHaveBeenCalledWith(
      'anthropic',
      'claude-sonnet-5-5',
      131_072
    );
    await flush();
    await flush();
    settle(env, session.id, 1);
    await vi.waitFor(() =>
      expect(env.sent('set-model').at(-1)).toMatchObject({ model: { maxOutput: 131_072 } })
    );
  });

  it('ignores a learned max output from a stale generation or another model', async () => {
    const { env, modelLimits } = limitsEnv(200_000);
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().emit({
      type: 'model-limits-learned',
      identity: { sessionId: session.id, generation: 2 },
      modelId: 'claude-sonnet-5-5',
      maxOutput: 131_072,
    });
    env.worker().emit({
      type: 'model-limits-learned',
      identity: identityOf(session.id),
      modelId: 'glm-x',
      maxOutput: 131_072,
    });
    expect(modelLimits.learnMaxOutput).not.toHaveBeenCalled();
  });

  it('learns the limit from a model overflow error and pushes it', async () => {
    const { env, providers, modelLimits } = limitsEnv(1_000_000);
    const message = 'prompt is too long: 300000 tokens > 272000 maximum';
    modelLimits.learn.mockImplementation(async () => {
      const model = providers[0]?.models[0];
      if (model) model.contextWindow = 272_000;
      return true;
    });
    const session = await createSession(env);
    await env.host.prompt(session.id, 'hi');
    env.worker().emit({
      type: 'session-event',
      identity: identityOf(session.id),
      seq: 1,
      event: { type: 'error', source: 'model', message, seq: 1 },
    });
    expect(modelLimits.learn).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5-5', message);
    await flush();
    await flush();
    settle(env, session.id, 2);
    await vi.waitFor(() =>
      expect(env.sent('set-model').at(-1)).toMatchObject({ model: { contextWindow: 272_000 } })
    );
  });
});

describe('createAgentHost profile sessions', () => {
  const personal = {
    skills: ['/skills/a'],
    mcpServers: [{ name: 'docs', transport: 'stdio', command: 'docs-mcp' }],
    plugins: ['/plugins/p'],
    pluginRefs: [{ id: 'p', path: '/plugins/p' }],
    instructionFile: { name: 'AGENTS.md', content: 'personal' },
    warnings: [],
  } as unknown as Awaited<ReturnType<NonNullable<AgentHostDeps['resolveResources']>>>;

  function profileEnv(overrides: Partial<AgentHostDeps> = {}) {
    const env = setup({
      resolveResources: async () => structuredClone(personal),
      resolvePluginProviders: async () => [],
      ...overrides,
    });
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const worktrees = join(env.dir, 'worktrees');
    const clean = join(worktrees, 'ws-1', 'clean');
    mkdirSync(clean, { recursive: true });
    env.host.setWorktreesRootLookup(async () => worktrees);
    return { ...env, worktrees, clean };
  }

  async function profileSession(
    env: ReturnType<typeof profileEnv>,
    profile: 'triage' | 'restricted',
    cwd = env.clean
  ) {
    const created = await env.host.createProfileSession({ workspaceId: 'ws-1', profile, cwd });
    if (!created.ok) throw new Error(created.error);
    await env.host.prompt(created.session.id, 'go');
    return created.session;
  }

  function invoke(
    env: ReturnType<typeof setup>,
    sessionId: string,
    kind: 'orchestration' | 'telegram' | 'config',
    method: string,
    input: unknown,
    callId = '1'
  ) {
    env.worker().emit({
      type: 'host-invoke',
      identity: { sessionId, generation: 1 },
      callId,
      kind,
      method,
      input,
    });
  }

  const lastResult = (env: ReturnType<typeof setup>) => {
    const sent = env.sent('host-result').at(-1);
    return sent?.type === 'host-result' ? sent.result : undefined;
  };

  function specOf(env: ReturnType<typeof setup>, sessionId: string): SpawnSessionSpec | undefined {
    const spawn = env
      .sent('spawn-session')
      .find(
        (command) => command.type === 'spawn-session' && command.identity.sessionId === sessionId
      );
    return spawn?.type === 'spawn-session' ? spawn.spec : undefined;
  }

  it('accepts only the repository root or a path under the workspace worktrees root', async () => {
    const env = profileEnv();
    const outside = join(env.dir, 'elsewhere');
    const otherWorkspace = join(env.worktrees, 'ws-2', 'x');
    mkdirSync(outside);
    mkdirSync(otherWorkspace, { recursive: true });
    for (const cwd of [
      outside,
      otherWorkspace,
      join(env.worktrees, 'ws-1'),
      join(env.worktrees, 'ws-1', 'missing'),
      'repo',
      join(env.clean, '..', '..', '..', 'elsewhere'),
    ]) {
      const created = await env.host.createProfileSession({
        workspaceId: 'ws-1',
        profile: 'restricted',
        cwd,
      });
      expect(created.ok, cwd).toBe(false);
    }
    expect(
      (
        await env.host.createProfileSession({
          workspaceId: 'ws-2',
          profile: 'triage',
          cwd: env.clean,
        })
      ).ok
    ).toBe(false);
    expect(env.store.all()).toEqual([]);

    const repo = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'triage',
      cwd: env.workspace.repoPath,
    });
    expect(repo).toMatchObject({ ok: true, session: { profile: 'triage', roleId: 'worker' } });
    const clean = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'restricted',
      cwd: env.clean,
      title: '渠道值班',
    });
    expect(clean).toMatchObject({
      ok: true,
      session: { profile: 'restricted', roleId: 'orchestrator', title: '渠道值班' },
    });
  });

  it('refuses a worktree path when the worktrees root is not wired', async () => {
    const env = setup();
    const clean = join(env.dir, 'worktrees', 'ws-1', 'clean');
    mkdirSync(clean, { recursive: true });
    const created = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'triage',
      cwd: clean,
    });
    expect(created.ok).toBe(false);
  });

  it('spawns profile sessions without MCP, plugins, skills or the instruction file', async () => {
    const env = profileEnv();
    const plain = await createSession(env);
    await env.host.prompt(plain.id, 'hi');
    expect(specOf(env, plain.id)).toMatchObject({
      skills: ['/skills/a'],
      plugins: ['/plugins/p'],
      instructionFile: { name: 'AGENTS.md' },
    });
    expect(specOf(env, plain.id)?.profile).toBeUndefined();

    for (const profile of ['triage', 'restricted'] as const) {
      const session = await profileSession(env, profile);
      const spec = specOf(env, session.id);
      expect(spec).toMatchObject({ profile, skills: [], mcpServers: [], plugins: [] });
      expect(spec).not.toHaveProperty('pluginRefs');
      expect(spec).not.toHaveProperty('pluginProviders');
      expect(spec).not.toHaveProperty('instructionFile');
      // 档位会话记录里的审批档位固定 supervised 作兜底
      expect(session.approvalMode).toBe('supervised');
      expect(env.store.get(session.id)?.approvalMode).toBe('supervised');
      expect(spec?.role.approvalMode).toBe('supervised');
    }
  });

  it('gives profile sessions the UI language name and leaves normal sessions alone', async () => {
    const env = profileEnv();
    const plain = await createSession(env);
    await env.host.prompt(plain.id, 'hi');
    expect(specOf(env, plain.id)).not.toHaveProperty('profileLanguage');
    for (const [language, name] of [
      ['zh-CN', 'Simplified Chinese'],
      ['en', 'English'],
    ] as const) {
      configureMainLocale({ language: () => language, systemLanguages: () => [] });
      try {
        for (const profile of ['triage', 'restricted'] as const) {
          const session = await profileSession(env, profile);
          const spec = specOf(env, session.id);
          expect(spec?.profileLanguage).toBe(name);
          expect(spec).not.toHaveProperty('instructionFile');
        }
      } finally {
        configureMainLocale(null);
      }
    }
  });

  it('refuses to switch the approval mode of a profile session and keeps the record', async () => {
    const env = profileEnv();
    for (const profile of ['triage', 'restricted'] as const) {
      const session = await profileSession(env, profile);
      const switched = await env.host.setApprovalMode({ sessionId: session.id, mode: 'full' });
      expect(switched.ok).toBe(false);
      expect(env.store.get(session.id)?.approvalMode).toBe('supervised');
      expect(env.sent('set-approval-mode')).toEqual([]);
    }
    const plain = await createSession(env);
    const switched = await env.host.setApprovalMode({ sessionId: plain.id, mode: 'full' });
    expect(switched).toMatchObject({ ok: true, session: { approvalMode: 'full' } });
    expect(env.store.get(plain.id)?.approvalMode).toBe('full');
  });

  it('makes every worker of a restricted coordinator restricted', async () => {
    const env = profileEnv();
    const coordinator = await profileSession(env, 'restricted');
    const plain = await createSession(env, 'orchestrator');
    let parent = coordinator.id;
    env.host.setCoordinatorLookup(() => parent);
    const launcher = env.host.implementsLauncher();
    const input = {
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'tester',
      cwd: join(env.worktrees, 'ws-1', 'fix'),
      brief: '# Fix it',
    };
    const restricted = await launcher.createWorkerSession(input);
    if (!restricted.ok) throw new Error(restricted.error);
    expect(env.store.get(restricted.sessionId)?.profile).toBe('restricted');
    expect(env.store.get(restricted.sessionId)?.approvalMode).toBe('supervised');
    expect(specOf(env, restricted.sessionId)).toMatchObject({
      profile: 'restricted',
      worker: true,
      skills: [],
      mcpServers: [],
      plugins: [],
    });
    expect(specOf(env, restricted.sessionId)).not.toHaveProperty('instructionFile');
    expect(specOf(env, restricted.sessionId)?.profileLanguage).toBe('Simplified Chinese');

    parent = plain.id;
    const normal = await launcher.createWorkerSession({ ...input, dispatchId: 'dsp_2' });
    if (!normal.ok) throw new Error(normal.error);
    expect(env.store.get(normal.sessionId)?.profile).toBeUndefined();
    expect(env.store.get(normal.sessionId)?.approvalMode).toBe(
      env.store.get(plain.id)?.approvalMode
    );

    // 查不到协调者的会话记录、或查不到协调者时一律受限（fail-closed）
    parent = 'session-missing';
    const orphan = await launcher.createWorkerSession({ ...input, dispatchId: 'dsp_3' });
    if (!orphan.ok) throw new Error(orphan.error);
    expect(env.store.get(orphan.sessionId)?.profile).toBe('restricted');
    env.host.setCoordinatorLookup(() => undefined);
    const unknown = await launcher.createWorkerSession({ ...input, dispatchId: 'dsp_4' });
    if (!unknown.ok) throw new Error(unknown.error);
    expect(env.store.get(unknown.sessionId)?.profile).toBe('restricted');
    expect(env.store.get(unknown.sessionId)?.approvalMode).toBe('supervised');
    expect(specOf(env, unknown.sessionId)).toMatchObject({ profile: 'restricted', mcpServers: [] });
  });

  it('refuses merge, non-whitelisted checks and a fourth task of a restricted coordinator', async () => {
    const env = profileEnv();
    const coordinator = await profileSession(env, 'restricted');
    const host = {
      mergeWorktree: vi.fn(async () => ({ ok: true as const, merged: true })),
      openPullRequest: vi.fn(async () => ({ ok: true as const, url: 'https://example.com/pr/1' })),
      runChecks: vi.fn(async () => ({ ok: true as const, exitCode: 0, output: '', durationMs: 1 })),
      dispatchTask: vi.fn(async () => ({ ok: true as const, taskId: 't', dispatchId: 'd' })),
    } as unknown as OrchestrationHost;
    env.host.setOrchestrationHostFactory(() => host);

    invoke(env, coordinator.id, 'orchestration', 'mergeWorktree', { dispatchId: 'd1' });
    await flush();
    expect(lastResult(env)).toEqual({
      ok: false,
      error: expect.stringContaining('open_pull_request'),
    });
    expect(host.mergeWorktree).not.toHaveBeenCalled();

    // 受限会话唯一的交付方式照常放行
    invoke(env, coordinator.id, 'orchestration', 'openPullRequest', {
      dispatchId: 'd1',
      title: 'Fix the crash',
      summary: 'Restores the intended behavior.',
    });
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: true, url: 'https://example.com/pr/1' });
    expect(host.openPullRequest).toHaveBeenCalledTimes(1);

    invoke(env, coordinator.id, 'orchestration', 'runChecks', {
      dispatchId: 'd1',
      command: 'pnpm test --run',
    });
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: false });
    expect(host.runChecks).not.toHaveBeenCalled();
    invoke(env, coordinator.id, 'orchestration', 'runChecks', {
      dispatchId: 'd1',
      command: 'pnpm lint',
    });
    await flush();
    expect(host.runChecks).toHaveBeenCalledTimes(1);
    // 单独的 pnpm test 在 Main 直接放行，不问人
    invoke(env, coordinator.id, 'orchestration', 'runChecks', {
      dispatchId: 'd1',
      command: 'pnpm test',
    });
    await flush();
    expect(host.runChecks).toHaveBeenCalledTimes(2);

    // 没接任务计数时不能派发（fail-closed）
    invoke(env, coordinator.id, 'orchestration', 'dispatchTask', { title: 't' });
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: false });
    const open = [coordinator.id, coordinator.id, 'someone-else'];
    env.host.setOpenTaskLookup(async () => open);
    invoke(env, coordinator.id, 'orchestration', 'dispatchTask', { title: 't' });
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: true });
    open.push(coordinator.id);
    invoke(env, coordinator.id, 'orchestration', 'dispatchTask', { title: 't' });
    await flush();
    expect(lastResult(env)).toEqual({ ok: false, error: expect.stringContaining('at most 3') });
    expect(host.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it('lets a normal coordinator merge and run any checks as before', async () => {
    const env = profileEnv();
    const coordinator = await createSession(env, 'orchestrator');
    await env.host.prompt(coordinator.id, 'go');
    const host = {
      mergeWorktree: vi.fn(async () => ({ ok: true as const, merged: true })),
      runChecks: vi.fn(async () => ({ ok: true as const, exitCode: 0, output: '', durationMs: 1 })),
    } as unknown as OrchestrationHost;
    env.host.setOrchestrationHostFactory(() => host);
    invoke(env, coordinator.id, 'orchestration', 'mergeWorktree', { dispatchId: 'd1' });
    invoke(
      env,
      coordinator.id,
      'orchestration',
      'runChecks',
      { dispatchId: 'd1', command: 'pnpm test' },
      '2'
    );
    await flush();
    expect(host.mergeWorktree).toHaveBeenCalledTimes(1);
    expect(host.runChecks).toHaveBeenCalledTimes(1);
  });

  it('gives triage no orchestration or configuration and only triage gets telegram', async () => {
    const telegram = { invoke: vi.fn(async () => ({ ok: true as const })) };
    const config = { invoke: vi.fn(async () => ({ ok: true as const })) };
    const env = profileEnv({ telegram, config });
    const factory = vi.fn(() => ({}) as OrchestrationHost);
    env.host.setOrchestrationHostFactory(factory);
    const triage = await profileSession(env, 'triage');

    invoke(env, triage.id, 'orchestration', 'listWorkers', undefined);
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: false });
    expect(factory).not.toHaveBeenCalled();
    invoke(env, triage.id, 'config', 'configure', { action: 'list' });
    await flush();
    expect(lastResult(env)).toMatchObject({ ok: false });
    expect(config.invoke).not.toHaveBeenCalled();

    const report = { kind: 'question', title: 't', summary: 's', reply: 'r' };
    invoke(env, triage.id, 'telegram', 'triageReport', report);
    await flush();
    expect(lastResult(env)).toEqual({ ok: true });
    expect(telegram.invoke).toHaveBeenCalledWith(
      triage.id,
      'triageReport',
      report,
      expect.any(AbortSignal)
    );

    const restricted = await profileSession(env, 'restricted');
    const plain = await createSession(env);
    await env.host.prompt(plain.id, 'hi');
    for (const sessionId of [restricted.id, plain.id]) {
      invoke(env, sessionId, 'telegram', 'triageReport', report);
      await flush();
      expect(lastResult(env)).toEqual({
        ok: false,
        error: expect.stringContaining('only available in triage sessions'),
      });
    }
    expect(telegram.invoke).toHaveBeenCalledTimes(1);
  });

  it('answers telegram calls with an error when no telegram host is wired', async () => {
    const env = profileEnv();
    const triage = await profileSession(env, 'triage');
    invoke(env, triage.id, 'telegram', 'triageReport', {});
    await flush();
    expect(lastResult(env)).toEqual({ ok: false, error: 'Telegram is not available' });
  });
});
describe('restricted dispatch limit through registry wiring', () => {
  it('counts unfinished tasks of the restricted coordinator from the orchestration snapshot', async () => {
    const env = setup();
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const registry = createOrchestrationRegistry({
      userDataPath: env.dir,
      listWorkspaces: () => [env.workspace],
      roles: createFakeRoles(),
      notifyChanged: vi.fn(),
      exec: createFakeExec().exec,
      runChecks: async () => ({ exitCode: 0, output: '', durationMs: 0 }),
    });
    await connectOrchestration(env.host, registry);
    const created = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'restricted',
      cwd: env.workspace.repoPath,
    });
    if (!created.ok) throw new Error(created.error);
    const coordinator = created.session.id;
    await env.host.prompt(coordinator, 'fix the reported bugs');
    const dispatch = async (callId: string) => {
      env.worker().emit({
        type: 'host-invoke',
        identity: { sessionId: coordinator, generation: 1 },
        callId,
        kind: 'orchestration',
        method: 'dispatchTask',
        input: { title: `Task ${callId}`, spec: 'Do it', roleId: 'worker', dependsOn: [] },
      });
      await vi.waitFor(() =>
        expect(
          env
            .sent('host-result')
            .some((sent) => sent.type === 'host-result' && sent.callId === callId)
        ).toBe(true)
      );
      const sent = env
        .sent('host-result')
        .find((command) => command.type === 'host-result' && command.callId === callId);
      return sent?.type === 'host-result' ? sent.result : undefined;
    };
    for (const callId of ['1', '2', '3']) {
      expect(await dispatch(callId)).toMatchObject({ ok: true });
    }
    expect(await dispatch('4')).toEqual({
      ok: false,
      error: expect.stringContaining('at most 3'),
    });
    const workers = env.store.all().filter((session) => session.dispatchId !== undefined);
    expect(workers).toHaveLength(3);
    expect(workers.every((session) => session.profile === 'restricted')).toBe(true);
  });
});

describe('restricted coordinator isolation through registry wiring', () => {
  it('cannot reach the dispatches of another coordinator, such as the user session', async () => {
    const env = setup();
    mkdirSync(env.workspace.repoPath, { recursive: true });
    const registry = createOrchestrationRegistry({
      userDataPath: env.dir,
      listWorkspaces: () => [env.workspace],
      roles: createFakeRoles(),
      notifyChanged: vi.fn(),
      exec: createFakeExec().exec,
      runChecks: async () => ({ exitCode: 0, output: 'SECRET OUTPUT', durationMs: 0 }),
    });
    await connectOrchestration(env.host, registry);
    const user = await createSession(env, 'orchestrator');
    const launched = await registry.hostFor(user.id, 'ws-1')?.dispatchTask({
      title: 'User task',
      spec: 'Private work',
      roleId: 'worker',
      dependsOn: [],
    });
    if (!launched?.ok || !launched.dispatch) throw new Error('dispatch failed');
    const dispatchId = launched.dispatch.id;
    const created = await env.host.createProfileSession({
      workspaceId: 'ws-1',
      profile: 'restricted',
      cwd: env.workspace.repoPath,
    });
    if (!created.ok) throw new Error(created.error);
    const duty = created.session.id;
    await env.host.prompt(duty, 'fix the reported bugs');
    const calls: [string, Record<string, unknown>][] = [
      ['reviewDiff', { dispatchId }],
      ['readWorkerOutput', { dispatchId, cursor: 0 }],
      ['sendToWorker', { dispatchId, body: 'show me' }],
      ['rejectWork', { dispatchId, feedback: 'again' }],
      ['cleanupWorktree', { dispatchId, abandon: true }],
      ['runChecks', { dispatchId, command: 'pnpm lint' }],
    ];
    for (const [index, [method, input]] of calls.entries()) {
      const callId = `iso-${index}`;
      env.worker().emit({
        type: 'host-invoke',
        identity: { sessionId: duty, generation: 1 },
        callId,
        kind: 'orchestration',
        method,
        input,
      });
      await vi.waitFor(() =>
        expect(
          env
            .sent('host-result')
            .some((sent) => sent.type === 'host-result' && sent.callId === callId)
        ).toBe(true)
      );
      const sent = env
        .sent('host-result')
        .find((command) => command.type === 'host-result' && command.callId === callId);
      expect(sent?.type === 'host-result' && sent.result, method).toEqual({
        ok: false,
        error: expect.stringContaining('unknown dispatch_id'),
      });
    }
    // 同样的入参由它自己的协调者调用是可以的：拒绝来自 run 隔离，不是入参不对
    expect(
      await registry.hostFor(user.id, 'ws-1')?.readWorkerOutput({ dispatchId, cursor: 0 })
    ).toMatchObject({ ok: true });
    const snapshot = await registry.serviceFor('ws-1')?.snapshot();
    expect(snapshot?.dispatches.find((entry) => entry.id === dispatchId)?.outcome).toBeUndefined();
  });
});
