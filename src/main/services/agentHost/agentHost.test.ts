import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole, type Role } from '@fynvra/core';
import type { AgentApprovalRequest, AgentCommand, ModelQuery } from '@shared/types/agent';
import type {
  ApprovalDecision,
  ModelThinkingCapability,
  SessionEventEnvelope,
  SessionModelRef,
} from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StoredProvider, toProviderView } from '../providers/providerStore';
import { createModelResolver, runtimeProviderId } from '../providers/resolveModel';
import { sessionFilePath } from '../sessions/history';
import { createSessionStore } from '../sessions/sessionStore';
import { type AgentHostDeps, createAgentHost, titleFrom } from './agentHost';
import type { WorkerProcess } from './workerClient';

class FakeProcess implements WorkerProcess {
  sent: AgentCommand[] = [];
  #onMessage: ((message: unknown) => void) | undefined;
  #onExit: ((code: number) => void) | undefined;
  postMessage(message: unknown): void {
    // 与真实通道一样走结构化克隆
    this.sent.push(structuredClone(message) as AgentCommand);
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
    });
    expect(env.host.list('ws-1')).toEqual([session]);
    expect(env.pushed(IPC_CHANNELS.SESSIONS_CHANGED)).toEqual([['ws-1']]);
    expect(env.sent()).toEqual([]);
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

  it('spawns with the skills and MCP servers resolved for the role and logs their warnings', async () => {
    const logs: string[] = [];
    const resolveResources = vi.fn(async () => ({
      skills: ['/skills/pdf'],
      mcpServers: [{ name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'ghp_secret' } }],
      warnings: ['skill "gone" of role "tester" is no longer registered; skipped'],
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

    expect(await env.host.history(session.id)).toEqual({ ok: true, messages: [] });
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
    const env = setup();
    const running = await createSession(env);
    const idle = await createSession(env, 'tester');
    await env.host.prompt(running.id, 'long task');
    await env.host.prompt(idle.id, 'quick');
    env.worker().emit({
      type: 'session-status',
      identity: { sessionId: idle.id, generation: 1 },
      status: 'idle',
    });

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

    expect(await launcher.promptSession('session-1', 'Review feedback: add edge cases')).toEqual({
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

    // 3. 会话空闲后 promptSession 作为新的 prompt 发出（新一轮，reject_work 靠它重新开放 report_done）
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(env.host.list('ws-1')[0]?.status).toBe('idle');
    expect(await launcher.promptSession(created.sessionId, 'Review feedback')).toEqual({
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
    time = 5_001;
    expect(await env.respond('allow')).toEqual({ ok: false, error: '审批请求已过期' });
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
});

describe('titleFrom', () => {
  it.each([
    ['## Fix the build\nmore', 'Fix the build'],
    ['\n\n  - list   item  ', 'list item'],
    ['', ''],
    ['x'.repeat(80), `${'x'.repeat(59)}…`],
  ])('%j → %j', (text, title) => {
    expect(titleFrom(text)).toBe(title);
  });
});
