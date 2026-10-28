import type {
  ApprovalGateRequest,
  ApprovalDecision as RuntimeApprovalDecision,
  ApprovalKind as RuntimeApprovalKind,
} from '@fynvra/agent-runtime';
import type { ApprovalMode, FynvraSessionEvent, FynvraSessionEventBody, Role } from '@fynvra/core';
import type {
  AgentWorkerEvent,
  ModelQuery,
  ResolvedModelSpec,
  SessionIdentity,
  SpawnSessionSpec,
} from '@shared/types/agent';
import type {
  ApprovalDecision,
  ApprovalKind,
  ChatImage,
  ModelThinkingCapability,
} from '@shared/types/chat';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type OpenSession,
  type OpenSessionInput,
  SessionSupervisor,
  type SupervisedSession,
} from './supervisor';

/**
 * 可脚本化的假会话，事件由测试手动发出。prompt 的时序与 pi 一致：空闲时开始一轮，
 * 直到 agent_settled 才 resolve；运行中到达的 prompt 只排队、立即 resolve。
 */
class FakeSession implements SupervisedSession {
  warnings: string[] = [];
  prompts: string[] = [];
  /** 每次 prompt 带的图片，与 prompts 一一对应（没带时为 undefined） */
  promptImages: (ChatImage[] | undefined)[] = [];
  steers: string[] = [];
  /** 每次 steer 带的图片，与 steers 一一对应（没带时为 undefined） */
  steerImages: (ChatImage[] | undefined)[] = [];
  aborts = 0;
  disposals = 0;
  idle = true;
  models: ResolvedModelSpec[] = [];
  approvalModes: ApprovalMode[] = [];
  /** 回合开始前的校验（抛错模拟缺 API key 等） */
  promptImpl: (text: string) => Promise<void> = async () => {};
  /** 换模型（抛错模拟注册 / 鉴权失败，挂起模拟慢的注册） */
  setModelImpl: (spec: ResolvedModelSpec) => Promise<void> = async () => {};
  /** 换审批档位（抛错模拟会话没有审批门） */
  setApprovalModeImpl: (mode: ApprovalMode) => void = () => {};
  #listener: ((event: FynvraSessionEvent) => void) | undefined;
  #seq = 0;
  #settleRun: (() => void) | undefined;

  subscribe(listener: (event: FynvraSessionEvent) => void) {
    this.#listener = listener;
    return {
      unsubscribe: () => {
        this.#listener = undefined;
      },
      emit: (event: FynvraSessionEventBody) => this.emit(event),
    };
  }

  emit(event: FynvraSessionEventBody): void {
    this.#seq += 1;
    if (event.type === 'agent_settled') this.idle = true;
    this.#listener?.({ ...event, seq: this.#seq } as FynvraSessionEvent);
    if (event.type === 'agent_settled') {
      this.#settleRun?.();
      this.#settleRun = undefined;
    }
  }

  async prompt(text: string, images?: ChatImage[]): Promise<void> {
    this.prompts.push(text);
    this.promptImages.push(images);
    await this.promptImpl(text);
    if (!this.idle) return;
    this.idle = false;
    await new Promise<void>((resolve) => {
      this.#settleRun = resolve;
    });
  }

  async steer(text: string, images?: ChatImage[]): Promise<void> {
    this.steers.push(text);
    this.steerImages.push(images);
  }

  async setModel(spec: ResolvedModelSpec): Promise<void> {
    await this.setModelImpl(spec);
    this.models.push(spec);
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.setApprovalModeImpl(mode);
    this.approvalModes.push(mode);
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    if (!this.idle) this.emit({ type: 'agent_settled', aborted: true });
  }

  isIdle(): boolean {
    return this.idle;
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
  }
}

const workerRole: Role = {
  id: 'worker',
  name: 'Worker',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};
const orchestratorRole: Role = { ...workerRole, id: 'orchestrator', tools: 'orchestrator' };

function spec(patch: Partial<SpawnSessionSpec> = {}): SpawnSessionSpec {
  return {
    role: workerRole,
    cwd: '/repo',
    sessionFile: '/data/agent/sessions/s1.jsonl',
    model: { providerId: 'anthropic', api: 'anthropic-messages', modelId: 'm', apiKey: 'k' },
    skills: [],
    mcpServers: [],
    worker: false,
    roles: [],
    ...patch,
  };
}

const id1: SessionIdentity = { sessionId: 's1', generation: 1 };

/** 让排队的微任务 / 已 resolve 的 promise 回调跑完 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  open?: OpenSession,
  describeModels?: (queries: ModelQuery[]) => Promise<ModelThinkingCapability[]>
) {
  const posted: AgentWorkerEvent[] = [];
  const sessions: FakeSession[] = [];
  const inputs: OpenSessionInput[] = [];
  const supervisor = new SessionSupervisor({
    post: (event) => posted.push(event),
    ...(describeModels ? { describeModels } : {}),
    openSession:
      open ??
      (async (input) => {
        inputs.push(input);
        const session = new FakeSession();
        sessions.push(session);
        return session;
      }),
    approvalTimeoutMs: 1_000,
  });
  const of = <T extends AgentWorkerEvent['type']>(type: T) =>
    posted.filter((event): event is Extract<AgentWorkerEvent, { type: T }> => event.type === type);
  return { posted, sessions, inputs, supervisor, of };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionSupervisor spawn and prompt', () => {
  it('queues a prompt behind a slow spawn and reports running', async () => {
    let finishOpen: (session: FakeSession) => void = () => {};
    const session = new FakeSession();
    const { supervisor, of } = setup(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'Fix the build' });
    await settle();
    expect(session.prompts).toEqual([]);

    finishOpen(session);
    await settle();
    expect(session.prompts).toEqual(['Fix the build']);
    expect(of('session-status')).toEqual([
      { type: 'session-status', identity: id1, status: 'running' },
    ]);
  });

  it('forwards normalized events with identity and seq, and settles to idle', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    const session = sessions[0] as FakeSession;
    session.emit({ type: 'text_delta', delta: 'Hel' });
    session.emit({ type: 'message_end', role: 'assistant', text: 'Hello' });
    session.emit({ type: 'agent_settled', aborted: false });

    expect(of('session-event')).toEqual([
      {
        type: 'session-event',
        identity: id1,
        seq: 1,
        event: { type: 'text_delta', delta: 'Hel', seq: 1 },
      },
      {
        type: 'session-event',
        identity: id1,
        seq: 2,
        event: { type: 'message_end', role: 'assistant', text: 'Hello', seq: 2 },
      },
      {
        type: 'session-event',
        identity: id1,
        seq: 3,
        event: { type: 'agent_settled', aborted: false, seq: 3 },
      },
    ]);
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'idle']);
  });

  it('reports error after a run that produced an error event', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    const session = sessions[0] as FakeSession;
    session.emit({ type: 'error', source: 'model', message: '401 invalid x-api-key' });
    session.emit({ type: 'agent_settled', aborted: false });
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'error']);

    // 下一轮重新开始计算
    supervisor.handle({ type: 'prompt', identity: id1, text: 'again' });
    await settle();
    session.emit({ type: 'agent_settled', aborted: false });
    expect(of('session-status').map((event) => event.status)).toEqual([
      'running',
      'error',
      'running',
      'idle',
    ]);
  });

  it('turns a prompt that fails before the run into an error event and status', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    await settle();
    (sessions[0] as FakeSession).promptImpl = async () => {
      throw new Error('No API key found for provider');
    };
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    expect(of('session-event').map((event) => event.event)).toEqual([
      { type: 'error', source: 'host', message: 'No API key found for provider', seq: 1 },
    ]);
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'error']);
  });

  it('logs session warnings', async () => {
    const session = new FakeSession();
    session.warnings = ['skill: path does not exist (C:\\skills\\x)'];
    const { supervisor, of } = setup(async () => session);
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    await settle();
    expect(of('log')).toEqual([
      {
        type: 'log',
        level: 'warn',
        message: 'session s1: skill: path does not exist (C:\\skills\\x)',
      },
    ]);
  });

  it('reports a failed spawn as fatal and keeps reporting the session as missing', async () => {
    const { supervisor, of } = setup(async () => {
      throw new Error('no base URL');
    });
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    expect(of('session-error')).toEqual([
      {
        type: 'session-error',
        identity: id1,
        error: 'failed to start the session: no base URL',
        fatal: true,
      },
    ]);
    supervisor.handle({ type: 'prompt', identity: id1, text: 'again' });
    expect(of('session-error').at(-1)).toMatchObject({
      fatal: true,
      error: expect.stringMatching(/not running/),
    });
  });

  it('hands the images of a prompt to the session, also when it queues behind a running turn', async () => {
    const screenshot: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const photo: ChatImage = { data: '/9j/4AAQ', mimeType: 'image/jpeg' };
    const { supervisor, sessions } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: '', images: [screenshot] });
    await settle();
    const session = sessions[0] as FakeSession;
    expect(session.prompts).toEqual(['']);
    expect(session.promptImages).toEqual([[screenshot]]);

    supervisor.handle({ type: 'prompt', identity: id1, text: 'and this one', images: [photo] });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'text only' });
    supervisor.handle({ type: 'steer', identity: id1, text: 'steer text only' });
    supervisor.handle({ type: 'steer', identity: id1, text: 'steer this', images: [photo] });
    await settle();
    expect(session.prompts).toEqual(['', 'and this one', 'text only']);
    expect(session.promptImages).toEqual([[screenshot], [photo], undefined]);
    expect(session.steers).toEqual(['steer text only', 'steer this']);
    expect(session.steerImages).toEqual([undefined, [photo]]);
  });

  it('runs steer as steer while busy and as a prompt while idle', async () => {
    const { supervisor, sessions } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'steer', identity: id1, text: 'start here' });
    await settle();
    const session = sessions[0] as FakeSession;
    expect(session.prompts).toEqual(['start here']);
    supervisor.handle({ type: 'steer', identity: id1, text: 'also check docs' });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'then summarize' });
    await settle();
    expect(session.steers).toEqual(['also check docs']);
    expect(session.prompts).toEqual(['start here', 'then summarize']);
  });

  it('aborts the run and settles to idle', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'long task' });
    await settle();
    const session = sessions[0] as FakeSession;
    supervisor.handle({ type: 'abort', identity: id1 });
    await settle();
    expect(session.aborts).toBe(1);
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'idle']);
  });
});

describe('SessionSupervisor generations and lifecycle', () => {
  it('drops commands of an older generation and ignores a spawn that is not newer', async () => {
    const { supervisor, sessions, of } = setup();
    const id2 = { ...id1, generation: 2 };
    supervisor.handle({ type: 'spawn-session', identity: id2, spec: spec() });
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'spawn-session', identity: id2, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'stale' });
    await settle();
    expect(sessions).toHaveLength(1);
    expect((sessions[0] as FakeSession).prompts).toEqual([]);
    expect(of('session-error')).toEqual([]);
    expect(of('log').map((event) => event.message)).toEqual([
      expect.stringContaining('generation 1 is not newer than 2'),
      expect.stringContaining('generation 2 is not newer than 2'),
      expect.stringContaining('dropped stale prompt'),
    ]);
  });

  it('replaces the session when a newer generation is spawned', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    await settle();
    const first = sessions[0] as FakeSession;
    supervisor.handle({ type: 'spawn-session', identity: { ...id1, generation: 2 }, spec: spec() });
    await settle();
    expect(first.disposals).toBe(1);
    first.emit({ type: 'text_delta', delta: 'late' });
    expect(of('session-event')).toEqual([]);
    expect(sessions).toHaveLength(2);
  });

  it('disposes a session, fails its pending host calls, and forgets it', async () => {
    const { supervisor, sessions, inputs, of } = setup();
    supervisor.handle({
      type: 'spawn-session',
      identity: id1,
      spec: spec({ role: orchestratorRole }),
    });
    await settle();
    const call = inputs[0]?.host?.listWorkers();
    supervisor.handle({ type: 'dispose-session', identity: id1 });
    await settle();
    await expect(call).resolves.toEqual({ ok: false, error: 'the session was closed' });
    expect((sessions[0] as FakeSession).disposals).toBe(1);
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    expect(of('session-error').at(-1)).toMatchObject({ fatal: true });
  });

  it('disposes a session that finishes opening after it was closed', async () => {
    let finishOpen: (session: FakeSession) => void = () => {};
    const session = new FakeSession();
    const { supervisor, of } = setup(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'dispose-session', identity: id1 });
    finishOpen(session);
    await settle();
    expect(session.disposals).toBe(1);
    session.emit({ type: 'text_delta', delta: 'x' });
    expect(of('session-event')).toEqual([]);
  });

  it('shuts down every session and ignores later commands', async () => {
    const { supervisor, sessions, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({
      type: 'spawn-session',
      identity: { sessionId: 's2', generation: 1 },
      spec: spec(),
    });
    await settle();
    await supervisor.shutdown();
    expect(sessions.map((session) => session.disposals)).toEqual([1, 1]);
    supervisor.handle({
      type: 'spawn-session',
      identity: { sessionId: 's3', generation: 1 },
      spec: spec(),
    });
    await settle();
    expect(sessions).toHaveLength(2);
    expect(of('log').at(-1)?.message).toContain('shutting down');
  });
});

describe('SessionSupervisor hosts', () => {
  it('gives only orchestrator-policy roles an orchestration host', async () => {
    const { supervisor, inputs } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({
      type: 'spawn-session',
      identity: { sessionId: 's2', generation: 1 },
      spec: spec({ role: orchestratorRole }),
    });
    await settle();
    expect(inputs.map((input) => [input.host !== null, input.workerHost !== null])).toEqual([
      [false, false],
      [true, false],
    ]);
  });

  it('round-trips a worker tool call through host-invoke and host-result', async () => {
    const { supervisor, inputs, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec({ worker: true }) });
    await settle();
    const report = inputs[0]?.workerHost?.reportDone('succeeded', 'all green', ['a.ts']);
    const invoke = of('host-invoke')[0];
    expect(invoke).toEqual({
      type: 'host-invoke',
      identity: id1,
      callId: '1',
      kind: 'worker',
      method: 'reportDone',
      input: { outcome: 'succeeded', summary: 'all green', filesModified: ['a.ts'] },
    });
    supervisor.handle({ type: 'host-result', identity: id1, callId: '1', result: { ok: true } });
    await expect(report).resolves.toEqual({ ok: true });
  });

  it('logs a host-result that no call is waiting for', () => {
    const { supervisor, of } = setup();
    supervisor.handle({ type: 'host-result', identity: id1, callId: '5', result: { ok: true } });
    expect(of('log')[0]?.message).toContain('dropped host-result 5');
  });
});

describe('SessionSupervisor operation notices and legacy approvals', () => {
  const gateRequest = (patch: Partial<ApprovalGateRequest> = {}): ApprovalGateRequest => ({
    toolCallId: 'call-1',
    toolName: 'bash',
    kind: 'command',
    title: 'bash',
    detail: 'rm -rf build',
    args: { command: 'rm -rf build' },
    protectedAction: 'rm -rf',
    expiresAt: 1_700_000_600_000,
    ...patch,
  });

  /** 会话已 spawn 并在跑一轮；返回工厂交给会话的审批通道 */
  async function running() {
    const env = setup();
    env.supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    env.supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    const approval = env.inputs[0]?.approval;
    if (!approval) throw new Error('the session factory got no approval channel');
    return { ...env, approval };
  }

  it('hands every session a notification channel without an approval timer', async () => {
    const { approval } = await running();
    expect(approval.notify).toBeTypeOf('function');
    expect(approval.timeoutMs).toBeUndefined();
  });

  it('emits ordered notices without announcing approval or waiting for an answer', async () => {
    const { supervisor, approval, sessions, posted, of } = await running();
    sessions[0]?.emit({ type: 'text_delta', delta: 'Working' });
    await approval.notify?.({ toolCallId: 'call-1', toolName: 'bash', kind: 'command' });
    sessions[0]?.emit({
      type: 'tool_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      output: 'ok',
      outputTruncated: false,
    });
    expect(of('approval-request')).toEqual([]);
    expect(of('session-event').map(({ event }) => [event.seq, event.type])).toEqual([
      [1, 'text_delta'],
      [2, 'tool_notice'],
      [3, 'tool_end'],
    ]);
    expect(of('session-event')[1]).toEqual({
      type: 'session-event',
      identity: id1,
      seq: 2,
      event: {
        type: 'tool_notice',
        toolCallId: 'call-1',
        toolName: 'bash',
        kind: 'command',
        seq: 2,
      },
    });
    expect(of('session-status').map((status) => status.status)).toEqual(['running']);
    const before = [...posted];
    supervisor.handle({
      type: 'respond-approval',
      identity: { ...id1, generation: 2 },
      requestId: 'old',
      decision: 'allow',
    });
    supervisor.handle({
      type: 'respond-approval',
      identity: id1,
      requestId: 'old',
      decision: 'deny',
    });
    expect(posted).toEqual(before);
  });

  it('the compatibility request immediately emits only a sanitized notice', async () => {
    const { approval, of } = await running();
    await expect(
      approval.request(
        gateRequest({ toolName: 'mcp__private__query', protectedAction: undefined }),
        new AbortController().signal
      )
    ).resolves.toBe('allow');
    expect(of('approval-request')).toEqual([]);
    expect(of('session-event').at(-1)?.event).toEqual({
      type: 'tool_notice',
      toolCallId: 'call-1',
      toolName: 'mcp',
      kind: 'mcp',
      seq: 1,
    });
  });

  it('late withdrawal and answers cannot change a completed notification', async () => {
    const { supervisor, approval, of } = await running();
    const withdraw = new AbortController();
    const decision = approval.request(gateRequest(), withdraw.signal);
    await expect(decision).resolves.toBe('allow');
    withdraw.abort();
    supervisor.handle({
      type: 'respond-approval',
      identity: id1,
      requestId: 'old',
      decision: 'deny',
    });
    await expect(decision).resolves.toBe('allow');
    expect(of('approval-request')).toEqual([]);
    expect(of('session-event')).toHaveLength(1);
    expect(of('session-status').at(-1)?.status).toBe('running');
  });

  it('denies without asking when the gate has already given up', async () => {
    const { approval, of } = await running();
    const withdraw = new AbortController();
    withdraw.abort();
    await expect(approval.request(gateRequest(), withdraw.signal)).resolves.toBe('deny');
    expect(of('approval-request')).toEqual([]);
  });

  it('Stop still aborts the real run after a notice without a pending answer', async () => {
    const { supervisor, approval, sessions, of } = await running();
    await expect(approval.request(gateRequest(), new AbortController().signal)).resolves.toBe(
      'allow'
    );
    supervisor.handle({ type: 'abort', identity: id1 });
    await settle();
    expect(sessions[0]?.aborts).toBe(1);
    expect(of('session-event').at(-1)?.event).toMatchObject({
      type: 'agent_settled',
      aborted: true,
    });
    expect(of('approval-request')).toEqual([]);
  });

  it('drops late notifications and rejects compatibility requests after disposal', async () => {
    const { supervisor, approval, sessions, of } = await running();
    await approval.notify?.({ toolCallId: 'call-1', toolName: 'bash', kind: 'command' });
    supervisor.handle({ type: 'dispose-session', identity: id1 });
    await settle();
    const events = [...of('session-event')];
    await approval.notify?.({ toolCallId: 'late', toolName: 'bash', kind: 'command' });
    await expect(approval.request(gateRequest(), new AbortController().signal)).resolves.toBe(
      'deny'
    );
    expect(of('session-event')).toEqual(events);
    expect(sessions[0]?.disposals).toBe(1);
  });

  it('settles normally after a notice without waiting or retracting the completed call', async () => {
    const { approval, sessions, of } = await running();
    const decision = approval.request(gateRequest(), new AbortController().signal);
    await expect(decision).resolves.toBe('allow');
    sessions[0]?.emit({ type: 'agent_settled', aborted: false });
    expect(of('session-status').map((status) => status.status)).toEqual(['running', 'idle']);
    expect(of('session-event').map(({ event }) => event.type)).toEqual([
      'tool_notice',
      'agent_settled',
    ]);
    await expect(decision).resolves.toBe('allow');
  });

  it('creates no timeout and ignores notifications from a replaced generation', async () => {
    const { supervisor, approval, inputs, of } = await running();
    vi.useFakeTimers();
    await expect(approval.request(gateRequest(), new AbortController().signal)).resolves.toBe(
      'allow'
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    supervisor.handle({ type: 'spawn-session', identity: { ...id1, generation: 2 }, spec: spec() });
    await vi.advanceTimersByTimeAsync(0);
    const events = [...of('session-event')];
    await approval.notify?.({ toolCallId: 'stale', toolName: 'bash', kind: 'command' });
    await expect(approval.request(gateRequest(), new AbortController().signal)).resolves.toBe(
      'deny'
    );
    expect(of('session-event')).toEqual(events);
    await inputs[1]?.approval?.notify?.({
      toolCallId: 'current',
      toolName: 'write',
      kind: 'file-write',
    });
    expect(of('session-event').at(-1)).toMatchObject({
      identity: { ...id1, generation: 2 },
      event: { type: 'tool_notice', toolCallId: 'current' },
    });
  });

  it('denies requests for sessions it does not hold', async () => {
    const { supervisor } = setup();
    await expect(supervisor.requestApproval(id1, gateRequest())).resolves.toBe('deny');
  });

  it('uses the same approval kinds and decisions as the Renderer contract', () => {
    expectTypeOf<RuntimeApprovalKind>().toEqualTypeOf<ApprovalKind>();
    expectTypeOf<RuntimeApprovalDecision>().toEqualTypeOf<ApprovalDecision>();
  });
});

describe('SessionSupervisor model switch', () => {
  const modelB: ResolvedModelSpec = {
    providerId: 'fynvra-b',
    api: 'openai-responses',
    modelId: 'gpt-5.5',
    apiKey: 'k-b',
    thinking: 'xhigh',
  };

  async function idleSession() {
    const env = setup();
    env.supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    await settle();
    return { ...env, session: env.sessions[0] as FakeSession };
  }

  it('hands set-model to the pi session without touching the status', async () => {
    const { supervisor, session, of } = await idleSession();
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    await settle();
    expect(session.models).toEqual([modelB]);
    expect(of('session-status')).toEqual([]);
    expect(of('session-error')).toEqual([]);
  });

  it('switches before a prompt that arrives after set-model, even while the switch is slow', async () => {
    const { supervisor, session } = await idleSession();
    let finishSwitch: () => void = () => {};
    session.setModelImpl = () =>
      new Promise<void>((resolve) => {
        finishSwitch = resolve;
      });
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'use the new model' });
    await settle();
    expect(session.prompts).toEqual([]);

    finishSwitch();
    await settle();
    expect(session.models).toEqual([modelB]);
    expect(session.prompts).toEqual(['use the new model']);
  });

  it('queues set-model behind a slow spawn', async () => {
    let finishOpen: (session: FakeSession) => void = () => {};
    const session = new FakeSession();
    const { supervisor } = setup(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    await settle();
    finishOpen(session);
    await settle();
    expect(session.models).toEqual([modelB]);
  });

  it('clears an error status after a successful switch', async () => {
    const { supervisor, session, of } = await idleSession();
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    session.emit({ type: 'error', source: 'model', message: '401 invalid key' });
    session.emit({ type: 'agent_settled', aborted: false });
    await settle();
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    await settle();
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'error', 'idle']);
  });

  it('closes the session and reports it as fatal when the switch fails', async () => {
    const { supervisor, session, of } = await idleSession();
    session.setModelImpl = async () => {
      throw new Error('No API key for fynvra-b/gpt-5.5');
    };
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'after the failed switch' });
    await settle();
    // worker 里的会话与 Main 的记录对不上了：关掉它，Main 下次使用前按记录重新 spawn
    expect(of('session-error')[0]).toEqual({
      type: 'session-error',
      identity: id1,
      error: 'failed to switch the model: No API key for fynvra-b/gpt-5.5',
      fatal: true,
    });
    expect(session.disposals).toBe(1);
    expect(session.prompts).toEqual([]);
    supervisor.handle({ type: 'prompt', identity: id1, text: 'again' });
    expect(of('session-error').at(-1)).toMatchObject({
      fatal: true,
      error: expect.stringMatching(/not running/),
    });
  });

  it('applies a switch that races with a running turn and logs it', async () => {
    const { supervisor, session, of } = await idleSession();
    supervisor.handle({ type: 'prompt', identity: id1, text: 'long task' });
    await settle();
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    await settle();
    expect(session.models).toEqual([modelB]);
    expect(of('log').map((event) => event.message)).toEqual([
      expect.stringContaining('during a turn'),
    ]);
  });

  it('drops set-model of an older generation and reports one for an unknown session', async () => {
    const { supervisor, session, of } = await idleSession();
    supervisor.handle({ type: 'spawn-session', identity: { ...id1, generation: 2 }, spec: spec() });
    supervisor.handle({ type: 'set-model', identity: id1, model: modelB });
    supervisor.handle({
      type: 'set-model',
      identity: { sessionId: 'ghost', generation: 1 },
      model: modelB,
    });
    await settle();
    expect(session.models).toEqual([]);
    expect(of('session-error')).toEqual([
      {
        type: 'session-error',
        identity: { sessionId: 'ghost', generation: 1 },
        error: 'the session is not running in the agent worker',
        fatal: true,
      },
    ]);
  });
});

describe('SessionSupervisor approval mode switch', () => {
  async function runningSession() {
    const env = setup();
    env.supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    env.supervisor.handle({ type: 'prompt', identity: id1, text: 'long task' });
    await settle();
    return { ...env, session: env.sessions[0] as FakeSession };
  }

  it('switches the gate of a running session right away, without ending the turn', async () => {
    const { supervisor, session, of } = await runningSession();
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'full' });
    await settle();
    expect(session.approvalModes).toEqual(['full']);
    expect(of('session-status').map((event) => event.status)).toEqual(['running']);
    expect(of('session-error')).toEqual([]);
    expect(session.aborts).toBe(0);
    expect(of('log').map((event) => event.message)).toEqual([
      expect.stringMatching(/s1: approval mode full/),
    ]);

    // 这一轮还在跑：后面的事件照常转发，结束后照常 settle
    session.emit({ type: 'text_delta', delta: 'still going' });
    session.emit({ type: 'agent_settled', aborted: false });
    expect(of('session-status').map((event) => event.status)).toEqual(['running', 'idle']);
  });

  it('queues the switch behind a slow spawn', async () => {
    let finishOpen: (session: FakeSession) => void = () => {};
    const session = new FakeSession();
    const { supervisor } = setup(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'supervised' });
    await settle();
    expect(session.approvalModes).toEqual([]);
    finishOpen(session);
    await settle();
    expect(session.approvalModes).toEqual(['supervised']);
  });

  it('applies switches in the order they arrive, after a model switch that came first', async () => {
    const { supervisor, session } = await runningSession();
    const order: string[] = [];
    let finishSwitch: () => void = () => {};
    session.setModelImpl = () =>
      new Promise<void>((resolve) => {
        finishSwitch = resolve;
      });
    session.setApprovalModeImpl = (mode) => order.push(mode);
    supervisor.handle({
      type: 'set-model',
      identity: id1,
      model: { providerId: 'p', api: 'anthropic-messages', modelId: 'm2' },
    });
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'full' });
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'auto-edits' });
    await settle();
    expect(order).toEqual([]);
    finishSwitch();
    await settle();
    expect(order).toEqual(['full', 'auto-edits']);
  });

  it('closes the session and reports it as fatal when the gate cannot be switched', async () => {
    const { supervisor, session, of } = await runningSession();
    session.setApprovalModeImpl = () => {
      throw new Error('this session has no approval gate to switch');
    };
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'supervised' });
    await settle();
    // 审批门可能还停在更宽松的旧档位：不能留着它继续跑，Main 下次使用前按记录重新 spawn
    expect(of('session-error')).toEqual([
      {
        type: 'session-error',
        identity: id1,
        error: 'failed to switch the approval mode: this session has no approval gate to switch',
        fatal: true,
      },
    ]);
    expect(session.disposals).toBe(1);
    session.emit({ type: 'text_delta', delta: 'after the failed switch' });
    expect(of('session-event')).toEqual([]);
  });

  it('drops a switch of an older generation and reports one for an unknown session', async () => {
    const { supervisor, session, of } = await runningSession();
    supervisor.handle({ type: 'spawn-session', identity: { ...id1, generation: 2 }, spec: spec() });
    supervisor.handle({ type: 'set-approval-mode', identity: id1, mode: 'full' });
    supervisor.handle({
      type: 'set-approval-mode',
      identity: { sessionId: 'ghost', generation: 1 },
      mode: 'full',
    });
    await settle();
    expect(session.approvalModes).toEqual([]);
    expect(of('session-error')).toEqual([
      {
        type: 'session-error',
        identity: { sessionId: 'ghost', generation: 1 },
        error: 'the session is not running in the agent worker',
        fatal: true,
      },
    ]);
  });
});

describe('SessionSupervisor describe-models', () => {
  const queries: ModelQuery[] = [
    { api: 'anthropic-messages', modelId: 'claude-opus-5-5' },
    { api: 'openai-completions', modelId: 'local', reasoning: true },
  ];

  it('answers with the capabilities of every queried model, in order', async () => {
    const describeModels = vi.fn(async (models: ModelQuery[]) =>
      models.map(
        (query): ModelThinkingCapability =>
          query.reasoning === undefined
            ? { thinkingLevels: ['low', 'medium'], defaultThinking: 'medium' }
            : { thinkingLevels: [] }
      )
    );
    const { supervisor, of } = setup(undefined, describeModels);
    supervisor.handle({ type: 'describe-models', requestId: 'describe-1', models: queries });
    await settle();
    expect(describeModels).toHaveBeenCalledWith(queries);
    expect(of('models-described')).toEqual([
      {
        type: 'models-described',
        requestId: 'describe-1',
        result: {
          ok: true,
          models: [
            { thinkingLevels: ['low', 'medium'], defaultThinking: 'medium' },
            { thinkingLevels: [] },
          ],
        },
      },
    ]);
  });

  it('answers with an error instead of leaving Main waiting', async () => {
    const failing = setup(undefined, async () => {
      throw new Error('the model catalog failed to load');
    });
    failing.supervisor.handle({ type: 'describe-models', requestId: 'd-1', models: queries });
    const missing = setup();
    missing.supervisor.handle({ type: 'describe-models', requestId: 'd-2', models: queries });
    await settle();
    expect(failing.of('models-described')).toEqual([
      {
        type: 'models-described',
        requestId: 'd-1',
        result: { ok: false, error: 'the model catalog failed to load' },
      },
    ]);
    expect(missing.of('models-described')[0]?.result).toMatchObject({ ok: false });
  });
});
