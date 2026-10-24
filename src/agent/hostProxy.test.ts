import { ORCHESTRATION_TOOL_METHODS, type OrchestrationHost } from '@fynvra/agent-runtime';
import type { AgentWorkerEvent, HostCallResult } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostInvoker,
  defaultHostCallTimeout,
  HOST_CALL_DEFAULT_TIMEOUT_MS,
  HOST_CALL_GRACE_MS,
  type HostCall,
  orchestrationHostProxy,
  workerHostProxy,
} from './hostProxy';

const identity = { sessionId: 'session-1', generation: 1 };

function setup(timeoutMs?: number) {
  const posted: AgentWorkerEvent[] = [];
  const invoker = createHostInvoker(
    (event) => posted.push(event),
    timeoutMs ? { timeoutFor: () => timeoutMs } : {}
  );
  return { posted, invoker };
}

describe('createHostInvoker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts host-invoke and resolves with the matching host-result', async () => {
    const { posted, invoker } = setup();
    const pending = invoker.invoke(identity, 'orchestration', 'listWorkers', undefined);
    expect(posted).toEqual([
      {
        type: 'host-invoke',
        identity,
        callId: '1',
        kind: 'orchestration',
        method: 'listWorkers',
        input: undefined,
      },
    ]);
    expect(invoker.settle(identity, '1', { ok: true, workers: [] })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, workers: [] });
    expect(invoker.pendingCount).toBe(0);
  });

  it('gives each call its own callId, so results can arrive out of order', async () => {
    const { posted, invoker } = setup();
    const first = invoker.invoke(identity, 'orchestration', 'reviewDiff', { dispatchId: 'd1' });
    const second = invoker.invoke(identity, 'orchestration', 'reviewDiff', { dispatchId: 'd2' });
    const callIds = posted.map((event) => (event.type === 'host-invoke' ? event.callId : ''));
    expect(new Set(callIds).size).toBe(2);
    invoker.settle(identity, callIds[1] as string, { ok: false, error: 'second' });
    invoker.settle(identity, callIds[0] as string, { ok: false, error: 'first' });
    await expect(first).resolves.toEqual({ ok: false, error: 'first' });
    await expect(second).resolves.toEqual({ ok: false, error: 'second' });
  });

  it('ignores results for another generation and for unknown calls', async () => {
    const { invoker } = setup();
    const pending = invoker.invoke(identity, 'worker', 'reportDone', { outcome: 'succeeded' });
    expect(invoker.settle({ ...identity, generation: 2 }, '1', { ok: true })).toBe(false);
    expect(invoker.settle(identity, '99', { ok: true })).toBe(false);
    expect(invoker.pendingCount).toBe(1);
    invoker.settle(identity, '1', { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('gives up after the timeout, tells Main to cancel and drops the late result', async () => {
    const { posted, invoker } = setup(1_000);
    const pending = invoker.invoke(identity, 'worker', 'askCoordinator', { question: 'q' });
    await vi.advanceTimersByTimeAsync(999);
    expect(invoker.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('no answer within 1 s'),
    });
    expect(posted.at(-1)).toEqual({ type: 'host-cancel', identity, callId: '1' });
    expect(invoker.settle(identity, '1', { ok: true })).toBe(false);
  });

  it('resolves as soon as the signal aborts and sends host-cancel', async () => {
    const { posted, invoker } = setup();
    const controller = new AbortController();
    const pending = invoker.invoke(
      identity,
      'orchestration',
      'waitForWorkers',
      { timeoutMs: 60_000, until: 'all' },
      controller.signal
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: 'waitForWorkers was aborted' });
    expect(posted.map((event) => event.type)).toEqual(['host-invoke', 'host-cancel']);
    expect(invoker.pendingCount).toBe(0);
  });

  it('does not contact Main for an already aborted signal', async () => {
    const { posted, invoker } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoker.invoke(identity, 'orchestration', 'listWorkers', undefined, controller.signal)
    ).resolves.toMatchObject({ ok: false });
    expect(posted).toEqual([]);
  });

  it('cancelSession fails only that identity, without host-cancel', async () => {
    const { posted, invoker } = setup();
    const mine = invoker.invoke(identity, 'orchestration', 'listWorkers', undefined);
    const other = invoker.invoke(
      { sessionId: 'session-2', generation: 1 },
      'orchestration',
      'listWorkers',
      undefined
    );
    invoker.cancelSession(identity, 'the session was closed');
    await expect(mine).resolves.toEqual({ ok: false, error: 'the session was closed' });
    expect(invoker.pendingCount).toBe(1);
    expect(posted.filter((event) => event.type === 'host-cancel')).toEqual([]);
    invoker.cancelAll('shutting down');
    await expect(other).resolves.toEqual({ ok: false, error: 'shutting down' });
  });

  it('turns a failing post into an error result instead of rejecting', async () => {
    const invoker = createHostInvoker(() => {
      throw new Error('port closed');
    });
    await expect(
      invoker.invoke(identity, 'orchestration', 'listWorkers', undefined)
    ).resolves.toEqual({ ok: false, error: 'listWorkers could not be sent: port closed' });
    expect(invoker.pendingCount).toBe(0);
  });
});

describe('defaultHostCallTimeout', () => {
  it('adds a grace period to the method timeout, otherwise uses the default', () => {
    expect(defaultHostCallTimeout('orchestration', 'waitForWorkers', { timeoutMs: 900_000 })).toBe(
      900_000 + HOST_CALL_GRACE_MS
    );
    expect(defaultHostCallTimeout('worker', 'askCoordinator', { timeoutMs: 600_000 })).toBe(
      600_000 + HOST_CALL_GRACE_MS
    );
    expect(
      defaultHostCallTimeout('orchestration', 'runChecks', {
        dispatchId: 'd',
        command: 'pnpm test',
      })
    ).toBe(HOST_CALL_DEFAULT_TIMEOUT_MS);
    expect(defaultHostCallTimeout('orchestration', 'listWorkers', undefined)).toBe(
      HOST_CALL_DEFAULT_TIMEOUT_MS
    );
    expect(defaultHostCallTimeout('orchestration', 'x', { timeoutMs: -1 })).toBe(
      HOST_CALL_DEFAULT_TIMEOUT_MS
    );
  });
});

describe('host proxies', () => {
  const ok = async (): Promise<HostCallResult> => ({ ok: true });

  it('forwards every OrchestrationHost method by name with its input and signal', async () => {
    const call = vi.fn<HostCall>(ok);
    const host = orchestrationHostProxy(call);
    const signal = new AbortController().signal;
    for (const method of Object.values(ORCHESTRATION_TOOL_METHODS)) {
      call.mockClear();
      const input = { dispatchId: 'd1', marker: method };
      if (method === 'listWorkers') await host.listWorkers(signal);
      else await (host[method] as (input: unknown, signal?: AbortSignal) => unknown)(input, signal);
      expect(call).toHaveBeenCalledWith(
        method,
        method === 'listWorkers' ? undefined : input,
        signal
      );
    }
    expect(Object.keys(host).sort()).toEqual(
      Object.values(ORCHESTRATION_TOOL_METHODS).sort() satisfies (keyof OrchestrationHost)[]
    );
  });

  it('packs WorkerHost positional arguments into one input object', async () => {
    const call = vi.fn<HostCall>(ok);
    const host = workerHostProxy(call);
    const signal = new AbortController().signal;
    await host.askCoordinator('Which DB?', 5_000, signal);
    expect(call).toHaveBeenLastCalledWith(
      'askCoordinator',
      { question: 'Which DB?', timeoutMs: 5_000 },
      signal
    );
    await host.reportDone('succeeded', 'done', ['a.ts']);
    expect(call).toHaveBeenLastCalledWith('reportDone', {
      outcome: 'succeeded',
      summary: 'done',
      filesModified: ['a.ts'],
    });
    await host.reportDone('failed', 'blocked');
    expect(call).toHaveBeenLastCalledWith('reportDone', { outcome: 'failed', summary: 'blocked' });
  });
});
