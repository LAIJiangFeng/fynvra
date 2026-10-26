import type { Message, MessageType } from '@fynvra/core';
import type { SessionEventEnvelope, SessionStatus, SessionSummary } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCoordinatorWake, wakePrompt } from './coordinatorWake';

// 协调者唤醒器（Orca 式）：收件箱出现 worker_done / question / escalation 且主 agent 会话空闲时，
// 把消息作为注入 prompt 唤醒它；忙则等回合结束再投。派发后主 agent 不再用 wait_for_workers 阻塞等待。

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    runId: 'run_1',
    from: 'session_w1',
    to: 'session_coord',
    type: 'worker_done',
    body: 'done',
    createdAt: 1,
    ...overrides,
  };
}

function envelope(sessionId: string): SessionEventEnvelope {
  return { sessionId, event: { type: 'agent_settled', aborted: false, seq: 1 } };
}

interface FakeHostOptions {
  status?: SessionStatus;
  exists?: boolean;
  failPrompts?: number;
}

/** 最小可用的 agentHost + registry 替身：记录 prompt 与 ack，收件箱按 sessionId 分桶 */
function fakes({ status = 'idle', exists = true, failPrompts = 0 }: FakeHostOptions = {}) {
  const inbox = new Map<string, Message[]>();
  const acked: string[] = [];
  const prompts: { sessionId: string; text: string }[] = [];
  const observers = new Set<(envelope: SessionEventEnvelope) => void>();
  const listeners = new Set<(workspaceId: string, message: Message) => void>();
  let failures = failPrompts;
  const statuses = new Map<string, SessionStatus>();

  const agentHost = {
    get: (sessionId: string) =>
      exists && !statuses.has(`${sessionId}:gone`)
        ? ({ id: sessionId, status: statuses.get(sessionId) ?? status } as SessionSummary)
        : undefined,
    prompt: async (sessionId: string, text: string) => {
      if (failures-- > 0) return { ok: false as const, error: 'worker unavailable' };
      prompts.push({ sessionId, text });
      return { ok: true as const };
    },
    observe: (observer: { event?(envelope: SessionEventEnvelope): void }) => {
      observers.add((envelope) => observer.event?.(envelope));
      return () => observers.delete;
    },
  };
  const registry = {
    onMessage: (listener: (workspaceId: string, message: Message) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pendingMessagesTo: (sessionId: string) => [...(inbox.get(sessionId) ?? [])],
    ackMessages: (ids: readonly string[]) => {
      acked.push(...ids);
      for (const [sessionId, messages] of inbox) {
        inbox.set(
          sessionId,
          messages.filter((candidate) => !ids.includes(candidate.id))
        );
      }
    },
  };
  return {
    agentHost,
    registry,
    prompts,
    acked,
    post: (message: Message) => {
      const bucket = inbox.get(message.to) ?? [];
      bucket.push(message);
      inbox.set(message.to, bucket);
      for (const listener of listeners) listener('ws_1', message);
    },
    settle: (sessionId: string) => {
      for (const observer of observers) observer(envelope(sessionId));
    },
    setStatus: (sessionId: string, next: SessionStatus) => statuses.set(sessionId, next),
    drop: (sessionId: string) => statuses.set(`${sessionId}:gone`, 'idle'),
  };
}

const DELAY = 100;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wakePrompt', () => {
  it('labels the notification as automated and gives each message a next step', () => {
    const text = wakePrompt([
      message({ id: 'msg_1', dispatchId: 'd_1', subject: 'Add toggle', body: 'Implemented.' }),
      message({
        id: 'msg_2',
        dispatchId: 'd_2',
        type: 'question',
        subject: 'which format?',
        body: 'JSON or YAML?',
      }),
    ]);
    expect(text).toContain('not a message from the user');
    expect(text).toContain('worker_done');
    expect(text).toContain('`d_1`');
    expect(text).toContain('Add toggle');
    expect(text).toContain('review_diff');
    expect(text).toContain('question');
    expect(text).toContain('send_to_worker');
  });
});

describe('installCoordinatorWake', () => {
  it('wakes an idle coordinator with worker_done messages and acks them', async () => {
    const f = fakes();
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.sessionId).toBe('session_coord');
    expect(f.prompts[0]?.text).toContain('`d_1`');
    expect(f.acked).toEqual(['msg_1']);
  });

  it('batches messages that arrive within the debounce into one prompt', async () => {
    const f = fakes();
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    f.post(message({ id: 'msg_2', dispatchId: 'd_2' }));
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.text).toContain('`d_1`');
    expect(f.prompts[0]?.text).toContain('`d_2`');
    expect(f.acked).toEqual(['msg_1', 'msg_2']);
  });

  it('ignores messages that are not wake types (instructions, replies)', async () => {
    const f = fakes();
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(
      message({
        id: 'msg_9',
        type: 'instruction' as MessageType,
        to: 'session_w1',
        from: 'session_coord',
      })
    );
    await vi.advanceTimersByTimeAsync(DELAY * 3);

    expect(f.prompts).toHaveLength(0);
  });

  it('holds messages while the coordinator runs and delivers them after it settles', async () => {
    const f = fakes({ status: 'running' });
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY * 3);
    expect(f.prompts).toHaveLength(0);

    f.setStatus('session_coord', 'idle');
    f.settle('session_coord');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.prompts).toHaveLength(1);
    expect(f.acked).toEqual(['msg_1']);
  });

  it('delivers nothing when the inbox was already drained by wait_for_workers', async () => {
    const f = fakes();
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    f.registry.ackMessages(['msg_1']);
    await vi.advanceTimersByTimeAsync(DELAY * 3);

    expect(f.prompts).toHaveLength(0);
  });

  it('does not ack on a failed prompt and retries', async () => {
    const f = fakes({ failPrompts: 1 });
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.prompts).toHaveLength(0);
    expect(f.acked).toEqual([]);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.prompts).toHaveLength(1);
    expect(f.acked).toEqual(['msg_1']);
  });

  it('stops rescheduling when the session errors out or is gone', async () => {
    const f = fakes({ status: 'error' });
    installCoordinatorWake({ agentHost: f.agentHost, registry: f.registry }, { delayMs: DELAY });
    f.post(message({ id: 'msg_1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.prompts).toHaveLength(0);

    const gone = fakes({ status: 'idle', exists: false });
    installCoordinatorWake(
      { agentHost: gone.agentHost, registry: gone.registry },
      { delayMs: DELAY }
    );
    gone.post(message({ id: 'msg_2', dispatchId: 'd_2' }));
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(gone.prompts).toHaveLength(0);
  });
});
