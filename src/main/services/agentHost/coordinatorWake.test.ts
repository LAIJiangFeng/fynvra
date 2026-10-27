import type { Message, MessageType } from '@fynvra/core';
import type { SessionStatus, SessionSummary } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingCoordinatorReview } from '../orchestration/service';
import type { AgentHostService, SessionObserver } from './agentHost';
import { installCoordinatorWake, wakePrompt } from './coordinatorWake';

const COORD = 'session_coord';
const DELAY = 100;

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    runId: 'run_1',
    from: 'session_w1',
    to: COORD,
    type: 'worker_done',
    body: 'done',
    createdAt: 1,
    ...overrides,
  };
}

function review(id = 'd_1'): PendingCoordinatorReview {
  return {
    taskId: `task_${id}`,
    title: 'Review the audit',
    dispatch: {
      id,
      taskId: `task_${id}`,
      workerSessionId: 'session_w1',
      worktreeId: 'wt_1',
      branch: 'fynvra/audit',
      startedAt: 1,
      settledAt: 2,
      outcome: 'succeeded',
      summary: 'Audit findings, no files modified.',
    },
  };
}

function fakes(status: SessionStatus = 'idle') {
  const inbox: Message[] = [];
  const reviews: PendingCoordinatorReview[] = [];
  const acked: string[] = [];
  const observers = new Set<SessionObserver>();
  const listeners = new Set<(workspaceId: string, message: Message) => void>();
  const session = { id: COORD, status } as SessionSummary;
  let exists = true;
  const agentHost = {
    get: vi.fn(() => (exists ? session : undefined)),
    promptWhenIdle: vi.fn<AgentHostService['promptWhenIdle']>(async (_sessionId, _text) => {
      session.status = 'running';
      return { ok: true as const, delivered: true };
    }),
    observe: (observer: SessionObserver) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
  const registry = {
    onMessage: (listener: (workspaceId: string, message: Message) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    coordinatorWork: vi.fn(() => ({ messages: [...inbox], reviews: [...reviews] })),
    ackMessages: (ids: readonly string[]) => {
      acked.push(...ids);
      for (let i = inbox.length - 1; i >= 0; i--) {
        if (ids.includes(inbox[i]?.id ?? '')) inbox.splice(i, 1);
      }
    },
  };
  const activity = (action: 'prompt' | 'abort' | 'idle') => {
    for (const observer of observers) observer.activity?.(COORD, action);
  };
  return {
    agentHost,
    registry,
    inbox,
    reviews,
    acked,
    session,
    activity,
    log: vi.fn(),
    post: (msg: Message) => {
      inbox.push(msg);
      for (const listener of listeners) listener('ws_1', msg);
    },
    settle: (aborted = false) => {
      for (const observer of observers) {
        observer.event?.({ sessionId: COORD, event: { type: 'agent_settled', aborted, seq: 1 } });
      }
      session.status = 'idle';
      activity('idle');
    },
    exists: (next: boolean) => {
      exists = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function install(f: ReturnType<typeof fakes>) {
  installCoordinatorWake(f, { delayMs: DELAY });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('wakePrompt', () => {
  it('distinguishes reviews, failed reports and questions, including read-only work', () => {
    const text = wakePrompt(
      [
        message({ id: 'm1', dispatchId: 'd_failed', subject: 'failed' }),
        message({ id: 'm2', dispatchId: 'd_question', type: 'question', body: 'JSON or YAML?' }),
      ],
      [review()]
    );
    expect(text).toContain('not a message from the user');
    expect(text).toContain('current dispatch_id `d_1`');
    expect(text).toContain('message delivery is not acceptance');
    expect(text).toContain('review_diff and run_checks as appropriate');
    expect(text).toContain('Read-only audits may have no code changes');
    expect(text).toContain('A failed report needs diagnosis');
    expect(text).toContain('send_to_worker');
    expect(text).toContain('Do not merge solely');
    expect(text).toContain('stop requests and required approvals');
  });
});

describe('installCoordinatorWake', () => {
  it('batches worker reports and acknowledges only the delivered messages', async () => {
    const f = fakes();
    install(f);
    f.reviews.push(review(), review('d_2'));
    f.post(message({ id: 'm1', dispatchId: 'd_1' }));
    f.post(message({ id: 'm2', dispatchId: 'd_2' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    expect(f.agentHost.promptWhenIdle.mock.calls[0]?.[1]).toContain('`d_2`');
    expect(f.acked).toEqual(['m1', 'm2']);
  });

  it.each(['running', 'waiting-approval'] as const)(
    'waits for events while %s, with no busy polling',
    async (status) => {
      const f = fakes(status);
      install(f);
      f.post(message({ id: 'm1', dispatchId: 'd_1' }));
      await vi.advanceTimersByTimeAsync(DELAY * 100);
      expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.acked).toEqual([]);
      f.settle();
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
      expect(f.acked).toEqual(['m1']);
    }
  );

  it('recovers an unresolved review after wait_for_workers already acknowledged the report', async () => {
    const f = fakes('running');
    install(f);
    f.reviews.push(review());
    f.post(message({ id: 'm1', dispatchId: 'd_1' }));
    f.registry.ackMessages(['m1']);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    expect(f.agentHost.promptWhenIdle.mock.calls[0]?.[1]).toContain('current dispatch_id `d_1`');
    expect(f.acked).toEqual(['m1']);
  });

  it('continues delivered-but-unresolved reviews once, then logs and stops without token loops', async () => {
    const f = fakes();
    install(f);
    f.reviews.push(review());
    f.post(message({ id: 'm1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(2);
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY * 100);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(2);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('review d_1 is still unresolved'));
    expect(vi.getTimerCount()).toBe(0);
    f.activity('prompt'); // The user explicitly continues; the budget can reopen.
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(3);
  });

  it.each(['completed', 'rejected', 'abandoned'])(
    'does not continue a review that is now %s',
    async () => {
      const f = fakes();
      install(f);
      f.reviews.push(review());
      f.post(message({ id: 'm1', dispatchId: 'd_1' }));
      await vi.advanceTimersByTimeAsync(DELAY);
      f.reviews.length = 0; // The service projection removes resolved/rejected attempts.
      f.settle();
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    }
  );

  it('uses the new dispatch after rejection and never carries the old attempt into recovery', async () => {
    const f = fakes();
    install(f);
    f.reviews.push(review());
    f.post(message({ id: 'm1', dispatchId: 'd_1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    f.reviews.splice(0, 1, review('d_retry'));
    f.post(message({ id: 'm2', dispatchId: 'd_retry' }));
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    const text = f.agentHost.promptWhenIdle.mock.calls[1]?.[1];
    expect(text).toContain('`d_retry`');
    expect(text).not.toContain('`d_1`');
  });

  it('does not repeat consumed messages when no review remains (including failed reports/questions)', async () => {
    const f = fakes('running');
    install(f);
    for (const type of ['worker_done', 'question', 'escalation'] as const) {
      f.post(message({ id: type, type }));
    }
    f.registry.ackMessages(f.inbox.map(({ id }) => id));
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
  });

  it.each(['reply', 'instruction', 'heartbeat'] as MessageType[])(
    'ignores %s as a wake trigger',
    async (type) => {
      const f = fakes();
      install(f);
      f.post(message({ id: 'ignored', type }));
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
    }
  );

  it('serializes in-flight prompts and delivers concurrent arrivals only after the turn settles', async () => {
    const f = fakes();
    const pending = deferred<{ ok: true; delivered: boolean }>();
    f.agentHost.promptWhenIdle.mockImplementationOnce(() => pending.promise);
    install(f);
    f.post(message({ id: 'm1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    f.post(message({ id: 'm2' }));
    f.activity('idle');
    await vi.advanceTimersByTimeAsync(DELAY * 10);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    f.session.status = 'running';
    pending.resolve({ ok: true, delivered: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.acked).toEqual(['m1']);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(2);
    expect(f.acked).toEqual(['m1', 'm2']);
    expect(f.agentHost.promptWhenIdle.mock.calls[1]?.[1]).not.toContain('message_id: `m1`');
  });

  it('retries thrown delivery failures with a finite backoff and preserves unacknowledged work', async () => {
    const f = fakes();
    f.agentHost.promptWhenIdle.mockRejectedValue(new Error('temporarily unavailable'));
    install(f);
    f.post(message({ id: 'm1' }));
    await vi.advanceTimersByTimeAsync(DELAY * 100);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(3);
    expect(f.acked).toEqual([]);
    expect(f.log).toHaveBeenLastCalledWith(expect.stringContaining('(3/3)'));
    f.settle();
    await vi.advanceTimersByTimeAsync(DELAY * 100);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a returned delivery error and acknowledges only after success', async () => {
    const f = fakes();
    f.agentHost.promptWhenIdle.mockResolvedValueOnce({ ok: false, error: 'unavailable' });
    install(f);
    f.post(message({ id: 'm1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.acked).toEqual([]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.acked).toEqual(['m1']);
  });

  it.each(['abort', 'settled-aborted'] as const)(
    'pauses on %s, including later worker messages, until an explicit continuation',
    async (action) => {
      const f = fakes();
      install(f);
      f.reviews.push(review());
      f.post(message({ id: 'm1' }));
      if (action === 'abort') f.activity('abort');
      else f.settle(true);
      f.post(message({ id: 'm2' }));
      f.activity('idle');
      await vi.advanceTimersByTimeAsync(DELAY * 100);
      expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      f.activity('prompt');
      f.session.status = 'running';
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
      f.settle();
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    }
  );

  it('does not retry an in-flight send cancelled by a user abort', async () => {
    const f = fakes();
    const pending = deferred<{ ok: true; delivered: boolean }>();
    f.agentHost.promptWhenIdle.mockImplementationOnce(() => pending.promise);
    install(f);
    f.post(message({ id: 'm1' }));
    await vi.advanceTimersByTimeAsync(DELAY);
    f.activity('abort');
    pending.resolve({ ok: true, delivered: false });
    await vi.advanceTimersByTimeAsync(DELAY * 100);
    expect(f.acked).toEqual([]);
    expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'error', 'archived'] as const)(
    'defers %s sessions and reconciles restored acked reviews on resume',
    async (kind) => {
      const f = fakes();
      f.reviews.push(review()); // Restored task state; no new onMessage notification.
      if (kind === 'missing') f.exists(false);
      if (kind === 'error') f.session.status = 'error';
      if (kind === 'archived') f.session.archivedAt = 1;
      install(f);
      f.activity('idle');
      await vi.advanceTimersByTimeAsync(DELAY * 100);
      expect(f.agentHost.promptWhenIdle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      f.exists(true);
      f.session.status = 'running';
      delete f.session.archivedAt;
      f.activity('prompt');
      f.settle();
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(f.agentHost.promptWhenIdle).toHaveBeenCalledTimes(1);
      expect(f.agentHost.promptWhenIdle.mock.calls[0]?.[1]).toContain('`d_1`');
    }
  );
});
