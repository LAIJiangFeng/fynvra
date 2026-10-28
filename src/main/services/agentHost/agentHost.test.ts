import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole, JsonFileRoleStore, type Role } from '@fynvra/core';
import type { AgentApprovalRequest, AgentCommand, ModelQuery } from '@shared/types/agent';
import type {
  ApprovalDecision,
  ChatImage,
  ModelThinkingCapability,
  SessionEventEnvelope,
  SessionModelRef,
} from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationRegistry } from '../orchestration/registry';
import { createFakeExec, createFakeRoles } from '../orchestration/testing';
import { type StoredProvider, toProviderView } from '../providers/providerStore';
import { createModelResolver, runtimeProviderId } from '../providers/resolveModel';
import { BRANCH_REFRESH_THROTTLE_MS, createBranchTracker } from '../sessions/branches';
import { sessionFilePath } from '../sessions/history';
import { createSessionStore } from '../sessions/sessionStore';
import { type AgentHostDeps, createAgentHost, titleFrom } from './agentHost';
import { connectOrchestration } from './connectOrchestration';
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

  it('settles a real retry through registry/host wiring and reconciles removal without a snapshot read', async () => {
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
    expect(env.sent('prompt')).toHaveLength(1);
    env.worker().emit({ type: 'session-status', identity, status: 'idle' });
    expect(await retry).toMatchObject({ ok: true });
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
    report('first');
    await flush();
    current = next; // reject_work registered its next dispatch while the old run is finishing.
    const delivery = env.launcher.promptSession(sessionId, 'Review feedback');
    await flush();
    env
      .worker()
      .emit({ type: 'session-status', identity: env.identity, status: 'waiting-approval' });
    await flush();
    expect(env.sent('prompt')).toHaveLength(1);
    expect(env.launcher.sessionFailure?.(sessionId)).toBeUndefined();
    report('late');
    await flush();
    expect(first.reportDone).toHaveBeenCalledTimes(2);
    expect(next.reportDone).not.toHaveBeenCalled();
    env.worker().emit({ type: 'session-status', identity: env.identity, status: 'idle' });
    expect(await delivery).toEqual({ ok: true });
    expect(env.sent('prompt')).toHaveLength(2);
    report('retry');
    await flush();
    expect(next.reportDone).toHaveBeenCalledWith('succeeded', 'retry', undefined);
  });

  it.each(['remove', 'abort', 'dispose'] as const)(
    'does not revive queued feedback after %s',
    async (stop) => {
      const env = await dispatched();
      const pending = env.launcher.promptSession(env.identity.sessionId, 'Review feedback');
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
    expect(await env.launcher.promptSession(env.identity.sessionId, 'Explicit retry')).toEqual({
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
    // 没有主 agent（未接线）：回落角色自己的档位
    env.host.setCoordinatorLookup(() => undefined);
    expect(await dispatch()).toMatchObject({ approvalMode: 'auto-edits' });
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
      ['tester', 'auto-edits'],
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
  ])('%j → %j', (text, title) => {
    expect(titleFrom(text)).toBe(title);
  });
});
