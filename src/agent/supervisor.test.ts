import type { FynvraSessionEvent, FynvraSessionEventBody, Role } from '@fynvra/core';
import type { AgentWorkerEvent, SessionIdentity, SpawnSessionSpec } from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  steers: string[] = [];
  aborts = 0;
  disposals = 0;
  idle = true;
  /** 回合开始前的校验（抛错模拟缺 API key 等） */
  promptImpl: (text: string) => Promise<void> = async () => {};
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

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    await this.promptImpl(text);
    if (!this.idle) return;
    this.idle = false;
    await new Promise<void>((resolve) => {
      this.#settleRun = resolve;
    });
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
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

function setup(open?: OpenSession) {
  const posted: AgentWorkerEvent[] = [];
  const sessions: FakeSession[] = [];
  const inputs: OpenSessionInput[] = [];
  const supervisor = new SessionSupervisor({
    post: (event) => posted.push(event),
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

describe('SessionSupervisor approvals', () => {
  it('emits approval_request, waits for respond-approval and restores running', async () => {
    const { supervisor, of } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    supervisor.handle({ type: 'prompt', identity: id1, text: 'hi' });
    await settle();
    const decision = supervisor.requestApproval(id1, {
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'rm -rf build' },
    });
    const request = of('session-event').at(-1)?.event;
    expect(request).toMatchObject({
      type: 'approval_request',
      toolName: 'bash',
      toolCallId: 'call-1',
    });
    expect(of('session-status').map((event) => event.status)).toEqual([
      'running',
      'waiting-approval',
    ]);

    const requestId = request?.type === 'approval_request' ? request.requestId : '';
    supervisor.handle({
      type: 'respond-approval',
      identity: { ...id1, generation: 2 },
      requestId,
      decision: 'allow',
    });
    supervisor.handle({ type: 'respond-approval', identity: id1, requestId, decision: 'allow' });
    await expect(decision).resolves.toBe('allow');
    expect(of('session-status').map((event) => event.status)).toEqual([
      'running',
      'waiting-approval',
      'running',
    ]);
    expect(of('log').map((event) => event.message)).toEqual([
      expect.stringContaining(`no pending approval ${requestId}`),
    ]);
  });

  it('denies an approval that is not answered in time', async () => {
    const { supervisor } = setup();
    supervisor.handle({ type: 'spawn-session', identity: id1, spec: spec() });
    await settle();
    vi.useFakeTimers();
    const decision = supervisor.requestApproval(id1, {
      toolCallId: 'c',
      toolName: 'bash',
      args: {},
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(decision).resolves.toBe('deny');
  });

  it('denies requests for sessions it does not hold', async () => {
    const { supervisor } = setup();
    await expect(
      supervisor.requestApproval(id1, { toolCallId: 'c', toolName: 'bash', args: {} })
    ).resolves.toBe('deny');
  });
});
