import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  invokeOrchestrationHost,
  invokeWorkerHost,
  ORCHESTRATION_HOST_METHODS,
} from './hostDispatch';

/** 假 Host：mocks 用来断言，host 是同一个对象按接口类型看（返回值不必符合各方法的输出类型） */
function orchestrationHost() {
  const ok = vi.fn(async () => ({ ok: true as const, marker: 'host' }));
  const mocks: Record<keyof OrchestrationHost, ReturnType<typeof vi.fn>> = {
    dispatchTask: ok,
    listWorkers: vi.fn(async () => ({ ok: true as const, workers: [] })),
    waitForWorkers: ok,
    readWorkerOutput: ok,
    sendToWorker: ok,
    reviewDiff: ok,
    runChecks: ok,
    mergeWorktree: ok,
    rejectWork: ok,
    cleanupWorktree: ok,
  };
  return { mocks, host: mocks as unknown as OrchestrationHost };
}

const signal = new AbortController().signal;

describe('invokeOrchestrationHost', () => {
  it('knows exactly the OrchestrationHost methods', () => {
    expect(Object.keys(ORCHESTRATION_HOST_METHODS).sort()).toEqual(
      Object.keys(orchestrationHost().mocks).sort()
    );
  });

  it('calls the named method with the input and the abort signal', async () => {
    const { host, mocks } = orchestrationHost();
    const input = { title: 'T', spec: 'S', roleId: 'worker', dependsOn: [] };
    await expect(invokeOrchestrationHost(host, 'dispatchTask', input, signal)).resolves.toEqual({
      ok: true,
      marker: 'host',
    });
    expect(mocks.dispatchTask).toHaveBeenCalledWith(input, signal);
    await invokeOrchestrationHost(host, 'listWorkers', undefined, signal);
    expect(mocks.listWorkers).toHaveBeenCalledWith(signal);
  });

  it.each([
    ['an unknown method', 'deleteEverything', {}],
    ['an inherited property', 'constructor', {}],
    ['a missing input object', 'reviewDiff', undefined],
    ['an array input', 'reviewDiff', ['d1']],
  ])('rejects %s without calling the host', async (_label, method, input) => {
    const { host, mocks } = orchestrationHost();
    const result = await invokeOrchestrationHost(host, method, input, signal);
    expect(result.ok).toBe(false);
    for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it('turns a throwing host and a malformed result into error results', async () => {
    const { host, mocks } = orchestrationHost();
    mocks.reviewDiff = vi.fn(async () => {
      throw new Error('git exploded');
    });
    await expect(
      invokeOrchestrationHost(host, 'reviewDiff', { dispatchId: 'd' }, signal)
    ).resolves.toEqual({
      ok: false,
      error: 'git exploded',
    });
    mocks.runChecks = vi.fn(async () => 'done');
    await expect(
      invokeOrchestrationHost(host, 'runChecks', { dispatchId: 'd', command: 'pnpm test' }, signal)
    ).resolves.toEqual({ ok: false, error: 'runChecks returned an invalid result' });
  });
});

describe('invokeWorkerHost', () => {
  const workerHost = () => ({
    askCoordinator: vi.fn<WorkerHost['askCoordinator']>(async () => ({ ok: true, answer: 'yes' })),
    reportDone: vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true })),
  });

  it('unpacks the worker tool arguments', async () => {
    const host = workerHost();
    await expect(
      invokeWorkerHost(
        host,
        'askCoordinator',
        { question: 'Which DB?', timeoutMs: 600_000 },
        signal
      )
    ).resolves.toEqual({ ok: true, answer: 'yes' });
    expect(host.askCoordinator).toHaveBeenCalledWith('Which DB?', 600_000, signal);
    await invokeWorkerHost(
      host,
      'reportDone',
      { outcome: 'succeeded', summary: 'done', filesModified: ['a.ts'] },
      signal
    );
    expect(host.reportDone).toHaveBeenLastCalledWith('succeeded', 'done', ['a.ts']);
    await invokeWorkerHost(host, 'reportDone', { outcome: 'failed', summary: 'blocked' }, signal);
    expect(host.reportDone).toHaveBeenLastCalledWith('failed', 'blocked', undefined);
  });

  it.each([
    ['an unknown method', 'deleteWorktree', {}],
    ['a question that is not text', 'askCoordinator', { question: 1, timeoutMs: 10 }],
    ['a non-positive timeout', 'askCoordinator', { question: 'q', timeoutMs: 0 }],
    ['an unknown outcome', 'reportDone', { outcome: 'great', summary: 's' }],
    ['a missing summary', 'reportDone', { outcome: 'succeeded' }],
    [
      'files that are not paths',
      'reportDone',
      { outcome: 'succeeded', summary: 's', filesModified: [1] },
    ],
  ])('rejects %s without calling the host', async (_label, method, input) => {
    const host = workerHost();
    expect((await invokeWorkerHost(host, method, input, signal)).ok).toBe(false);
    expect(host.askCoordinator).not.toHaveBeenCalled();
    expect(host.reportDone).not.toHaveBeenCalled();
  });
});
