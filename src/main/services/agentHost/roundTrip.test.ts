import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole } from '@fynvra/core';
import type { SessionEventEnvelope } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenSession } from '../../../agent/supervisor';
import { createModelResolver } from '../providers/resolveModel';
import { createSessionStore } from '../sessions/sessionStore';
import { createAgentHost } from './agentHost';
import { InMemoryWorker, ScriptedSession } from './testing';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(openSession: OpenSession) {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-round-trip-'));
  dirs.push(dir);
  const broadcasts: unknown[][] = [];
  const workspace = {
    id: 'ws-1',
    name: 'demo',
    repoPath: join(dir, 'repo'),
    defaultBranch: 'main',
  };
  const host = createAgentHost({
    fork: () => new InMemoryWorker(openSession),
    agentDir: join(dir, 'agent'),
    store: createSessionStore({ filePath: join(dir, 'sessions.json') }),
    workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
    roles: { get: async (id) => getBuiltinRole(id), list: async () => [...BUILTIN_ROLES] },
    models: createModelResolver({
      list: async () => [
        {
          id: 'anthropic',
          name: 'Anthropic',
          api: 'anthropic-messages',
          enabled: true,
          models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
          apiKey: 'sk-test',
        },
      ],
    }),
    broadcast: (...args) => broadcasts.push(args),
    log: () => {},
  });
  host.start();
  const events = (sessionId: string) =>
    broadcasts
      .filter(([channel]) => channel === IPC_CHANNELS.SESSIONS_EVENT)
      .map(([, envelope]) => envelope as SessionEventEnvelope)
      .filter((envelope) => envelope.sessionId === sessionId)
      .map((envelope) => envelope.event);
  const settled = (sessionId: string) =>
    vi.waitFor(() => {
      expect(events(sessionId).some((event) => event.type === 'agent_settled')).toBe(true);
    });
  return { host, events, settled };
}

describe('host-invoke round trip through the protocol', () => {
  it('runs an orchestration tool call on the Main host and hands the result back to the session', async () => {
    const openSession: OpenSession = async ({ host }) =>
      new ScriptedSession(async (_text, emit) => {
        const result = await host?.dispatchTask({
          title: 'Add tests',
          spec: 'Cover the parser',
          roleId: 'worker',
          dependsOn: [],
        });
        emit({
          type: 'text_delta',
          delta: result?.ok ? `dispatched ${result.task.id}` : `failed: ${result?.error}`,
        });
      });
    const env = setup(openSession);
    const dispatchTask = vi.fn<OrchestrationHost['dispatchTask']>(async (input) => ({
      ok: true,
      task: {
        id: 'task_1',
        runId: 'run_1',
        title: input.title,
        spec: input.spec,
        roleId: input.roleId,
        status: 'in-progress',
        dependsOn: [],
      },
    }));
    env.host.setOrchestrationHostFactory(() => ({ dispatchTask }) as unknown as OrchestrationHost);

    const created = await env.host.create({ workspaceId: 'ws-1', roleId: 'orchestrator' });
    if (!created.ok) throw new Error(created.error);
    expect(await env.host.prompt(created.session.id, 'Add tests for the parser')).toEqual({
      ok: true,
    });
    await env.settled(created.session.id);

    expect(dispatchTask).toHaveBeenCalledWith(
      { title: 'Add tests', spec: 'Cover the parser', roleId: 'worker', dependsOn: [] },
      expect.any(AbortSignal)
    );
    expect(env.events(created.session.id)).toEqual([
      { type: 'message_end', role: 'user', text: 'Add tests for the parser', seq: 1 },
      { type: 'text_delta', delta: 'dispatched task_1', seq: 2 },
      { type: 'agent_settled', aborted: false, seq: 3 },
    ]);
    await vi.waitFor(() => expect(env.host.list('ws-1')[0]?.status).toBe('idle'));
  });

  it('returns the "not wired" error text to the tool when no orchestration host is injected', async () => {
    const openSession: OpenSession = async ({ host }) =>
      new ScriptedSession(async (_text, emit) => {
        const result = await host?.listWorkers();
        emit({ type: 'text_delta', delta: result?.ok ? 'listed' : (result?.error ?? '') });
      });
    const env = setup(openSession);
    const created = await env.host.create({ workspaceId: 'ws-1', roleId: 'orchestrator' });
    if (!created.ok) throw new Error(created.error);
    await env.host.prompt(created.session.id, 'status?');
    await env.settled(created.session.id);
    expect(env.events(created.session.id)[1]).toMatchObject({
      type: 'text_delta',
      delta: expect.stringContaining('not wired'),
    });
  });

  it('routes report_done of a dispatched worker session to the Main WorkerHost', async () => {
    const openSession: OpenSession = async ({ workerHost }) =>
      new ScriptedSession(async (_text, emit) => {
        const reported = await workerHost?.reportDone('succeeded', 'Tests added', ['a.test.ts']);
        emit({ type: 'text_delta', delta: reported?.ok ? 'reported' : 'not reported' });
      });
    const env = setup(openSession);
    const reportDone = vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true }));
    const factory = vi.fn(() => ({ askCoordinator: vi.fn(), reportDone }) as WorkerHost);
    env.host.setWorkerHostFactory(factory);

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
    await env.settled(created.sessionId);
    expect(factory).toHaveBeenCalledWith(created.sessionId);
    expect(reportDone).toHaveBeenCalledWith('succeeded', 'Tests added', ['a.test.ts']);
    expect(
      env.events(created.sessionId).map((event) => event.type === 'text_delta' && event.delta)
    ).toContain('reported');
  });
});
