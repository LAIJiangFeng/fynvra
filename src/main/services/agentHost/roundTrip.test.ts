import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalGate, type OrchestrationHost, type WorkerHost } from '@fynvra/agent-runtime';
import { BUILTIN_ROLES, getBuiltinRole, type Role } from '@fynvra/core';
import type { ModelQuery } from '@shared/types/agent';
import type {
  ApprovalRequest,
  ModelThinkingCapability,
  SessionEventEnvelope,
} from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenSession, SupervisorOptions } from '../../../agent/supervisor';
import { type StoredProvider, toProviderView } from '../providers/providerStore';
import { createModelResolver } from '../providers/resolveModel';
import { createSessionStore } from '../sessions/sessionStore';
import { createAgentHost } from './agentHost';
import { InMemoryWorker, ScriptedSession } from './testing';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROVIDERS: StoredProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    enabled: true,
    models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
    apiKey: 'sk-test',
  },
];

function setup(
  openSession: OpenSession,
  extraRoles: Role[] = [],
  worker: Pick<SupervisorOptions, 'describeModels'> = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-round-trip-'));
  dirs.push(dir);
  const broadcasts: unknown[][] = [];
  const workspace = {
    id: 'ws-1',
    name: 'demo',
    repoPath: join(dir, 'repo'),
    vcs: 'git' as const,
    defaultBranch: 'main',
  };
  const host = createAgentHost({
    fork: () => new InMemoryWorker(openSession, worker),
    agentDir: join(dir, 'agent'),
    store: createSessionStore({ filePath: join(dir, 'sessions.json') }),
    workspaces: { get: (id) => (id === workspace.id ? workspace : undefined) },
    roles: {
      get: async (id) => getBuiltinRole(id) ?? extraRoles.find((role) => role.id === id),
      list: async () => [...BUILTIN_ROLES, ...extraRoles],
    },
    models: createModelResolver({ list: async () => structuredClone(PROVIDERS) }),
    providers: { list: async () => PROVIDERS.map(toProviderView) },
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
  const approvals = () =>
    broadcasts
      .filter(([channel]) => channel === IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)
      .map(([, request]) => request as ApprovalRequest);
  return { host, events, settled, approvals };
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

describe('operation notification round trip through the protocol', () => {
  const careful: Role = {
    id: 'careful',
    name: 'Careful',
    skillIds: [],
    mcpServerIds: [],
    tools: 'all',
    approvalMode: 'supervised',
  };

  /** 模拟工具执行，通过真实通知门与 supervisor 接线；afterCommand 可暂停工具脚本。 */
  const bashSession =
    (commands: string[], afterCommand?: (call: number) => Promise<void>): OpenSession =>
    async ({ spec, approval }) => {
      if (!approval) throw new Error('the supervisor gave the session no approval channel');
      const gate = createApprovalGate({ mode: spec.role.approvalMode, ...approval });
      let calls = 0;
      const session = new ScriptedSession(async (_text, emit) => {
        for (const command of commands) {
          const toolCallId = `call-${++calls}`;
          const args = { command };
          emit({ type: 'tool_start', toolCallId, toolName: 'bash', args });
          const verdict = await gate.check({ toolCallId, toolName: 'bash', input: args });
          emit({
            type: 'tool_end',
            toolCallId,
            toolName: 'bash',
            isError: verdict !== undefined,
            output: verdict ? verdict.reason : command.replace(/^echo /, ''),
            outputTruncated: false,
          });
          await afterCommand?.(calls);
        }
      });
      // 换档位切的就是这个审批门（生产里 piSession 经 onGate 拿到 createRoleSession 建的那个）
      session.setApprovalMode = (mode) => gate.setMode(mode);
      return session;
    };

  async function started(env: ReturnType<typeof setup>, roleId: string, text: string) {
    const created = await env.host.create({ workspaceId: 'ws-1', roleId });
    if (!created.ok) throw new Error(created.error);
    expect(await env.host.prompt(created.session.id, text)).toEqual({ ok: true });
    return created.session.id;
  }

  it('notifies before a supervised tool finishes without waiting for an answer', async () => {
    const env = setup(bashSession(['echo hi']), [careful]);
    const sessionId = await started(env, 'careful', 'Say hi');
    await env.settled(sessionId);

    expect(env.approvals()).toEqual([]);
    expect(env.events(sessionId)).toEqual([
      { type: 'message_end', role: 'user', text: 'Say hi', seq: 1 },
      {
        type: 'tool_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'echo hi' },
        seq: 2,
      },
      { type: 'tool_notice', toolCallId: 'call-1', toolName: 'bash', kind: 'command', seq: 3 },
      {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        output: 'hi',
        outputTruncated: false,
        seq: 4,
      },
      { type: 'agent_settled', aborted: false, seq: 5 },
    ]);
    await vi.waitFor(() => expect(env.host.list('ws-1')[0]?.status).toBe('idle'));
  });

  it('rejects late legacy decisions without changing or replaying a completed tool', async () => {
    const env = setup(bashSession(['echo hi']), [careful]);
    const sessionId = await started(env, 'careful', 'Say hi');
    await env.settled(sessionId);
    const completed = [...env.events(sessionId)];
    expect(
      await env.host.respondApproval({ sessionId, requestId: 'old', decision: 'deny' })
    ).toMatchObject({ ok: false });
    expect(env.events(sessionId)).toEqual(completed);
    expect(env.events(sessionId).filter((event) => event.type === 'tool_end')).toEqual([
      expect.objectContaining({ isError: false, output: 'hi' }),
    ]);
    expect(env.approvals()).toEqual([]);
  });

  it('notifies for every auto-edits worker command including important commands', async () => {
    const env = setup(bashSession(['echo one', 'echo two', 'git push']));
    const created = await env.host.implementsLauncher().createWorkerSession({
      workspaceId: 'ws-1',
      runId: 'run_1',
      dispatchId: 'dsp_1',
      roleId: 'worker',
      cwd: '/worktrees/ws-1/task',
      worktreeId: 'wt_1',
      brief: '# Task',
    });
    if (!created.ok) throw new Error(created.error);

    await env.settled(created.sessionId);
    expect(env.approvals()).toEqual([]);
    expect(
      env
        .events(created.sessionId)
        .filter((event) => event.type === 'tool_notice')
        .map((event) => event.toolCallId)
    ).toEqual(['call-1', 'call-2', 'call-3']);

    const ends = env.events(created.sessionId).filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.type === 'tool_end' && [event.isError, event.output])).toEqual(
      [
        [false, 'one'],
        [false, 'two'],
        [false, 'git push'],
      ]
    );
  });

  it('switches a running session to full: only important later commands notify', async () => {
    let firstExecuted = false;
    let resume: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const env = setup(
      bashSession(['echo one', 'echo two', 'git push'], async (call) => {
        if (call !== 1) return;
        firstExecuted = true;
        await paused;
      }),
      [careful]
    );
    const sessionId = await started(env, 'careful', 'Run them');
    await vi.waitFor(() => expect(firstExecuted).toBe(true));
    expect(env.host.list('ws-1')[0]?.approvalMode).toBe('supervised');
    expect(env.host.list('ws-1')[0]?.status).toBe('running');

    expect(await env.host.setApprovalMode({ sessionId, mode: 'full' })).toMatchObject({
      ok: true,
      session: { approvalMode: 'full', status: 'running' },
    });
    resume();
    await env.settled(sessionId);
    expect(env.approvals()).toEqual([]);
    expect(
      env
        .events(sessionId)
        .filter((event) => event.type === 'tool_notice')
        .map((event) => event.toolCallId)
    ).toEqual(['call-1', 'call-3']);

    const ends = env.events(sessionId).filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.type === 'tool_end' && [event.isError, event.output])).toEqual(
      [
        [false, 'one'],
        [false, 'two'],
        [false, 'git push'],
      ]
    );
  });
});

describe('model switch round trip through the protocol', () => {
  it('answers describe-models from the worker and switches the live session with set-model', async () => {
    const sessions: ScriptedSession[] = [];
    const openSession: OpenSession = async () => {
      const session = new ScriptedSession(async () => {});
      sessions.push(session);
      return session;
    };
    const describeModels = vi.fn(async (queries: ModelQuery[]) =>
      queries.map(
        (): ModelThinkingCapability => ({
          thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
          defaultThinking: 'medium',
        })
      )
    );
    const env = setup(openSession, [], { describeModels });

    expect(await env.host.modelOptions({})).toEqual({
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
              thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
              defaultThinking: 'medium',
            },
          ],
        },
      ],
    });
    expect(describeModels).toHaveBeenCalledWith([
      { api: 'anthropic-messages', modelId: 'claude-sonnet-5-5' },
    ]);

    const created = await env.host.create({ workspaceId: 'ws-1', roleId: 'worker' });
    if (!created.ok) throw new Error(created.error);
    await env.host.prompt(created.session.id, 'hi');
    await env.settled(created.session.id);
    await vi.waitFor(() => expect(env.host.list('ws-1')[0]?.status).toBe('idle'));

    const switched = await env.host.setModel({
      sessionId: created.session.id,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', thinking: 'xhigh' },
    });
    expect(switched).toMatchObject({ ok: true, session: { model: { thinking: 'xhigh' } } });
    await vi.waitFor(() =>
      expect(sessions[0]?.models).toEqual([
        expect.objectContaining({
          modelId: 'claude-sonnet-5-5',
          apiKey: 'sk-test',
          thinking: 'xhigh',
        }),
      ])
    );
  });
});
