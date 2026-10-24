import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole, type Role } from '@fynvra/core';
import type { AgentCommand } from '@shared/types/agent';
import type { SessionEventEnvelope } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFilePath } from '../sessions/history';
import { createSessionStore } from '../sessions/sessionStore';
import { type AgentHostDeps, createAgentHost, titleFrom } from './agentHost';
import { envModelResolver } from './envModelResolver';
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
    models: envModelResolver({ FYNVRA_ANTHROPIC_API_KEY: 'sk-test-secret' }),
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

  it('refuses unknown workspaces and roles, and models it cannot resolve', async () => {
    const env = setup({ models: envModelResolver({}) });
    expect(await env.host.create({ workspaceId: 'nope', roleId: 'worker' })).toMatchObject({
      ok: false,
    });
    expect(await env.host.create({ workspaceId: 'ws-1', roleId: 'ghost' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('ghost'),
    });
    expect(await env.host.create({ workspaceId: 'ws-1', roleId: 'worker' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('FYNVRA_ANTHROPIC_API_KEY'),
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
          providerId: 'anthropic',
          api: 'anthropic-messages',
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
      env.sent().map((command) => [command.type, command.type !== 'shutdown' && command.identity])
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
});

describe('createAgentHost approvals', () => {
  it('announces approval requests and forwards the decision once', async () => {
    const env = setup();
    const session = await createSession(env);
    await env.host.prompt(session.id, 'clean up');
    const identity = { sessionId: session.id, generation: 1 };
    env.worker().emit({
      type: 'session-event',
      identity,
      seq: 1,
      event: {
        type: 'approval_request',
        requestId: 'req-1',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'rm -rf build' },
        seq: 1,
      },
    });
    expect(env.pushed(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)).toEqual([
      [
        {
          id: 'req-1',
          sessionId: session.id,
          kind: 'command',
          title: 'bash',
          detail: 'rm -rf build',
          expiresAt: 1_000 + 10 * 60_000,
        },
      ],
    ]);
    expect(
      await env.host.respondApproval({ sessionId: 'other', requestId: 'req-1', decision: 'allow' })
    ).toMatchObject({ ok: false });
    expect(
      await env.host.respondApproval({
        sessionId: session.id,
        requestId: 'req-1',
        decision: 'allow',
      })
    ).toEqual({ ok: true });
    expect(env.sent('respond-approval')).toEqual([
      { type: 'respond-approval', identity, requestId: 'req-1', decision: 'allow' },
    ]);
    expect(
      await env.host.respondApproval({
        sessionId: session.id,
        requestId: 'req-1',
        decision: 'deny',
      })
    ).toMatchObject({ ok: false });
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
