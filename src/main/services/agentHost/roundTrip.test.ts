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

describe('approval round trip through the protocol', () => {
  const careful: Role = {
    id: 'careful',
    name: 'Careful',
    skillIds: [],
    mcpServerIds: [],
    tools: 'all',
    approvalMode: 'supervised',
  };

  /**
   * 代替 pi 的会话：每次 prompt 依次「调用」这些 bash 命令。工具开始后先过真实的审批门
   * （按角色档位，经 supervisor 的审批通道），放行才「执行」，拦截时把拒绝文本当作工具结果。
   */
  const bashSession =
    (...commands: string[]): OpenSession =>
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

  const waitForApprovals = (env: ReturnType<typeof setup>, count: number) =>
    vi.waitFor(() => {
      expect(env.approvals()).toHaveLength(count);
    });

  it('asks before a supervised session runs bash and lets the tool run once allowed', async () => {
    const env = setup(bashSession('echo hi'), [careful]);
    const sessionId = await started(env, 'careful', 'Say hi');

    await waitForApprovals(env, 1);
    const [request] = env.approvals();
    expect(request).toEqual({
      id: expect.any(String),
      sessionId,
      kind: 'command',
      title: 'bash',
      detail: 'echo hi',
      expiresAt: expect.any(Number),
    });
    await vi.waitFor(() => expect(env.host.list('ws-1')[0]?.status).toBe('waiting-approval'));
    expect(env.events(sessionId).map((event) => event.type)).toEqual([
      'message_end',
      'tool_start',
      'approval_request',
    ]);
    expect(env.events(sessionId)[2]).toMatchObject({
      requestId: request?.id,
      toolCallId: 'call-1',
    });

    expect(
      await env.host.respondApproval({ sessionId, requestId: request?.id ?? '', decision: 'allow' })
    ).toEqual({ ok: true });
    await env.settled(sessionId);

    expect(env.events(sessionId).slice(3)).toEqual([
      expect.objectContaining({
        type: 'tool_end',
        toolCallId: 'call-1',
        isError: false,
        output: 'hi',
      }),
      expect.objectContaining({ type: 'agent_settled', aborted: false }),
    ]);
    await vi.waitFor(() => expect(env.host.list('ws-1')[0]?.status).toBe('idle'));
  });

  it('hands the refusal to the session as the tool result when denied', async () => {
    const env = setup(bashSession('echo hi'), [careful]);
    const sessionId = await started(env, 'careful', 'Say hi');
    await waitForApprovals(env, 1);

    await env.host.respondApproval({
      sessionId,
      requestId: env.approvals()[0]?.id ?? '',
      decision: 'deny',
    });
    await env.settled(sessionId);

    expect(env.events(sessionId).find((event) => event.type === 'tool_end')).toMatchObject({
      isError: true,
      output: expect.stringContaining('The user denied the command `echo hi`'),
    });
  });

  it('asks a dispatched worker (auto-edits) once when the user allows the session', async () => {
    const env = setup(bashSession('echo one', 'echo two', 'git push'));
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

    await waitForApprovals(env, 1);
    await env.host.respondApproval({
      sessionId: created.sessionId,
      requestId: env.approvals()[0]?.id ?? '',
      decision: 'allowSession',
    });
    // echo two 不再询问；git push 是保护底线，照样要人确认
    await waitForApprovals(env, 2);
    expect(env.approvals()[1]).toMatchObject({
      kind: 'command',
      title: 'bash（保护底线：git push）',
      detail: 'git push',
    });
    await env.host.respondApproval({
      sessionId: created.sessionId,
      requestId: env.approvals()[1]?.id ?? '',
      decision: 'deny',
    });
    await env.settled(created.sessionId);

    const ends = env.events(created.sessionId).filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.type === 'tool_end' && [event.isError, event.output])).toEqual(
      [
        [false, 'one'],
        [false, 'two'],
        [true, expect.stringContaining('protected action (git push)')],
      ]
    );
  });

  it('switches a running supervised session to full: the next bash runs at once, git push still asks', async () => {
    const env = setup(bashSession('echo one', 'echo two', 'git push'), [careful]);
    const sessionId = await started(env, 'careful', 'Run them');
    await waitForApprovals(env, 1);
    expect(env.host.list('ws-1')[0]?.approvalMode).toBe('supervised');

    // 第一条还在等审批时切到 full：这一条仍以答复为准，之后的普通命令不再询问
    expect(await env.host.setApprovalMode({ sessionId, mode: 'full' })).toMatchObject({
      ok: true,
      session: { approvalMode: 'full', status: 'waiting-approval' },
    });
    await env.host.respondApproval({
      sessionId,
      requestId: env.approvals()[0]?.id ?? '',
      decision: 'allow',
    });
    await waitForApprovals(env, 2);
    expect(env.approvals()[1]).toMatchObject({
      title: 'bash（保护底线：git push）',
      detail: 'git push',
    });
    await env.host.respondApproval({
      sessionId,
      requestId: env.approvals()[1]?.id ?? '',
      decision: 'deny',
    });
    await env.settled(sessionId);

    const ends = env.events(sessionId).filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.type === 'tool_end' && [event.isError, event.output])).toEqual(
      [
        [false, 'one'],
        [false, 'two'],
        [true, expect.stringContaining('protected action (git push)')],
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
