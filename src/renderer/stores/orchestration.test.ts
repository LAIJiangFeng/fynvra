import type { Dispatch, Message, Task } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationApi, OrchestrationSnapshotView } from '../lib/api/orchestration';
import {
  activeDispatchOf,
  createOrchestrationStore,
  dispatchesOf,
  latestDispatchOf,
  latestMessageOfTask,
  mergeSnapshot,
  messagesOf,
  OUTPUT_POLL_MS,
  reviewCandidatesOf,
  tasksByStatus,
} from './orchestration';

function task(id: string, status: Task['status'], runId = 'run_1'): Task {
  return { id, runId, title: id, spec: '', roleId: 'worker', status, dependsOn: [] };
}

function dispatch(id: string, taskId: string, startedAt: number, settledAt?: number): Dispatch {
  return {
    id,
    taskId,
    workerSessionId: `session_${id}`,
    worktreeId: `worktree_${taskId}`,
    branch: `fynvra/${taskId}`,
    startedAt,
    ...(settledAt === undefined ? {} : { settledAt, outcome: 'succeeded' as const }),
  };
}

function message(id: string, dispatchId: string, createdAt: number, type: Message['type']) {
  return {
    id,
    runId: 'run_1',
    dispatchId,
    from: 'worker',
    to: 'coordinator',
    type,
    body: id,
    createdAt,
  } satisfies Message;
}

function view(overrides: Partial<OrchestrationSnapshotView> = {}): OrchestrationSnapshotView {
  return {
    runs: [
      {
        id: 'run_1',
        workspaceId: 'ws',
        coordinatorSessionId: 'coordinator',
        objective: 'ship it',
        createdAt: 1,
      },
    ],
    tasks: [task('task_a', 'completed'), task('task_b', 'in-progress'), task('task_c', 'todo')],
    dispatches: [dispatch('dispatch_a1', 'task_a', 10, 20), dispatch('dispatch_b1', 'task_b', 30)],
    worktrees: [],
    messages: [
      message('m2', 'dispatch_b1', 50, 'reply'),
      message('m1', 'dispatch_b1', 40, 'question'),
      message('m0', 'dispatch_a1', 20, 'worker_done'),
    ],
    ...overrides,
  };
}

/** structuredClone 模拟 IPC：每次拿到的都是新对象 */
const overIpc = <T>(value: T): T => structuredClone(value);

function fakeApi(initial: OrchestrationSnapshotView = view()) {
  const listeners = new Set<(workspaceId: string) => void>();
  const output = { text: '', done: false, pageChars: Number.POSITIVE_INFINITY, error: '' };
  const state = { view: initial };
  const api = {
    snapshot: vi.fn(async (_workspaceId: string) => ({
      ok: true as const,
      ...overIpc(state.view),
    })),
    readWorkerOutput: vi.fn(async ({ cursor }: { dispatchId: string; cursor: number }) => {
      if (output.error) return { ok: false as const, error: output.error };
      const from = Math.min(cursor, output.text.length);
      return {
        ok: true as const,
        text: output.text.slice(from, from + output.pageChars),
        total: output.text.length,
        done: output.done,
      };
    }),
    reviewDiff: vi.fn(async (dispatchId: string) => ({
      ok: true as const,
      branch: `fynvra/${dispatchId}`,
      baseCommit: 'abc',
      files: ['a.ts'],
      stat: ' 1 file changed',
      diff: 'diff --git a/a.ts b/a.ts\n',
    })),
    onChanged: vi.fn((callback: (workspaceId: string) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
  } satisfies OrchestrationApi;
  return {
    api,
    state,
    output,
    emit(workspaceId: string) {
      for (const listener of listeners) listener(workspaceId);
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('mergeSnapshot', () => {
  it('takes the first snapshot as is', () => {
    const next = view();
    expect(mergeSnapshot(null, next)).toBe(next);
  });

  it('keeps the previous snapshot when nothing changed', () => {
    const previous = view();
    expect(mergeSnapshot(previous, overIpc(previous))).toBe(previous);
  });

  it('reuses unchanged records and collections, replaces changed ones', () => {
    const previous = view();
    const next = overIpc(previous);
    const changed = next.tasks[1];
    if (changed) changed.status = 'in-review';
    next.messages.push(message('m3', 'dispatch_b1', 60, 'worker_done'));

    const merged = mergeSnapshot(previous, next);
    expect(merged).not.toBe(previous);
    expect(merged.runs).toBe(previous.runs);
    expect(merged.dispatches).toBe(previous.dispatches);
    expect(merged.tasks).not.toBe(previous.tasks);
    expect(merged.tasks[0]).toBe(previous.tasks[0]);
    expect(merged.tasks[1]).toEqual({ ...previous.tasks[1], status: 'in-review' });
    expect(merged.messages.slice(0, 3)).toEqual(previous.messages);
    expect(merged.messages[0]).toBe(previous.messages[0]);
  });

  it('drops records that disappeared', () => {
    const previous = view();
    const next = overIpc(previous);
    next.dispatches.pop();
    expect(mergeSnapshot(previous, next).dispatches.map((d) => d.id)).toEqual(['dispatch_a1']);
  });
});

describe('selectors', () => {
  it('groups the tasks of a run by status in dispatch order', () => {
    const snapshot = view({
      tasks: [
        task('task_a', 'completed'),
        task('task_b', 'in-progress'),
        task('task_x', 'in-progress', 'run_2'),
        task('task_c', 'in-progress'),
        task('task_d', 'abandoned'),
      ],
    });
    const groups = tasksByStatus(snapshot, 'run_1');
    expect(groups['in-progress'].map((t) => t.id)).toEqual(['task_b', 'task_c']);
    expect(groups.completed.map((t) => t.id)).toEqual(['task_a']);
    expect(groups.abandoned.map((t) => t.id)).toEqual(['task_d']);
    expect(groups.todo).toEqual([]);
    expect(tasksByStatus(snapshot, 'run_1')).toBe(groups);
    expect(tasksByStatus(null, 'run_1').todo).toEqual([]);
  });

  it('finds the running attempt and the latest attempt of a task', () => {
    const snapshot = view({
      dispatches: [
        dispatch('dispatch_b2', 'task_b', 300),
        dispatch('dispatch_b1', 'task_b', 100, 200),
        dispatch('dispatch_a1', 'task_a', 10, 20),
        dispatch('dispatch_a2', 'task_a', 30, 40),
      ],
    });
    expect(dispatchesOf(snapshot, 'task_b').map((d) => d.id)).toEqual([
      'dispatch_b1',
      'dispatch_b2',
    ]);
    expect(activeDispatchOf(snapshot, 'task_b')?.id).toBe('dispatch_b2');
    expect(latestDispatchOf(snapshot, 'task_b')?.id).toBe('dispatch_b2');
    expect(activeDispatchOf(snapshot, 'task_a')).toBeUndefined();
    expect(latestDispatchOf(snapshot, 'task_a')?.id).toBe('dispatch_a2');
    expect(dispatchesOf(snapshot, 'task_none')).toEqual([]);
  });

  it('lists the messages of a dispatch by time and keeps the reference stable', () => {
    const snapshot = view();
    const messages = messagesOf(snapshot, 'dispatch_b1');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messagesOf(snapshot, 'dispatch_b1')).toBe(messages);
    expect(messagesOf(snapshot, 'dispatch_none')).toEqual([]);
  });

  it('offers the current attempt of reviewable tasks, in-review first and newest first', () => {
    const snapshot = view({
      tasks: [
        task('task_a', 'completed'),
        task('task_b', 'in-progress'),
        task('task_c', 'in-review'),
        task('task_d', 'in-review'),
        task('task_e', 'in-review', 'run_2'),
        task('task_f', 'completed'),
      ],
      dispatches: [
        dispatch('dispatch_a1', 'task_a', 10, 20),
        dispatch('dispatch_b1', 'task_b', 30),
        dispatch('dispatch_c1', 'task_c', 40, 50),
        dispatch('dispatch_c2', 'task_c', 70, 80),
        dispatch('dispatch_d1', 'task_d', 55, 60),
        dispatch('dispatch_e1', 'task_e', 55, 90),
      ],
    });
    const candidates = reviewCandidatesOf(snapshot, 'run_1');
    expect(candidates.map((candidate) => candidate.dispatch.id)).toEqual([
      'dispatch_c2',
      'dispatch_d1',
      'dispatch_a1',
    ]);
    expect(candidates[0]?.task.id).toBe('task_c');
    expect(reviewCandidatesOf(snapshot, 'run_1')).toBe(candidates);
    expect(reviewCandidatesOf(null, 'run_1')).toEqual([]);
  });

  it('finds the latest message across all attempts of a task', () => {
    const snapshot = view({
      dispatches: [
        dispatch('dispatch_b1', 'task_b', 30, 35),
        dispatch('dispatch_b2', 'task_b', 36),
      ],
      messages: [
        message('m1', 'dispatch_b1', 40, 'question'),
        message('m3', 'dispatch_b2', 70, 'instruction'),
        message('m2', 'dispatch_b1', 50, 'reply'),
      ],
    });
    expect(latestMessageOfTask(snapshot, 'task_b')?.id).toBe('m3');
    expect(latestMessageOfTask(snapshot, 'task_c')).toBeUndefined();
  });
});

describe('createOrchestrationStore · snapshots', () => {
  it('loads a watched workspace and refetches it when Main reports a change', async () => {
    const { api, state, emit } = fakeApi();
    const store = createOrchestrationStore(api);

    await store.getState().refresh('ws');
    const stop = store.getState().watchWorkspace('ws');
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    const first = store.getState().snapshots.ws?.view;
    expect(first?.tasks).toHaveLength(3);

    state.view = view({ tasks: [...view().tasks, task('task_d', 'todo')] });
    emit('ws');
    await vi.waitFor(() =>
      expect(store.getState().snapshots.ws?.view?.tasks.map((t) => t.id)).toContain('task_d')
    );
    expect(store.getState().snapshots.ws?.view?.runs).toBe(first?.runs);
    expect(store.getState().snapshots.ws?.loading).toBe(false);

    emit('other');
    stop();
    emit('ws');
    await Promise.resolve();
    expect(api.snapshot).toHaveBeenCalledTimes(3);
  });

  it('coalesces changes that arrive while a snapshot is in flight', async () => {
    const { api, emit } = fakeApi();
    const gate = deferred<void>();
    const original = api.snapshot.getMockImplementation();
    api.snapshot.mockImplementationOnce(async (workspaceId: string) => {
      await gate.promise;
      if (!original) throw new Error('missing implementation');
      return original(workspaceId);
    });
    const store = createOrchestrationStore(api);
    store.getState().watchWorkspace('ws');
    emit('ws');
    emit('ws');
    emit('ws');
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().snapshots.ws?.loading).toBe(false));
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    const { api } = fakeApi();
    const store = createOrchestrationStore(api);
    await store.getState().refresh('ws');
    const good = store.getState().snapshots.ws?.view;

    api.snapshot.mockResolvedValueOnce({ ok: false, error: '工作区不存在' } as never);
    await store.getState().refresh('ws');
    expect(store.getState().snapshots.ws).toEqual({
      view: good,
      loading: false,
      error: '工作区不存在',
    });

    api.snapshot.mockRejectedValueOnce(new Error('ipc down'));
    await store.getState().refresh('ws');
    expect(store.getState().snapshots.ws?.error).toBe('ipc down');
  });
});

describe('createOrchestrationStore · worker output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 让 fetch → set → 下一次 fetch 的 promise 链走完 */
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('advances the cursor page by page and polls every 1.5s until the worker settles', async () => {
    const { api, output } = fakeApi();
    output.text = 'abcdefghij';
    output.pageChars = 4;
    const store = createOrchestrationStore(api);

    store.getState().watchOutput('dispatch_b1');
    await flush();
    // 一次读不完时立即接着读，cursor 按返回文本的长度递进
    expect(api.readWorkerOutput.mock.calls.map(([input]) => input.cursor)).toEqual([0, 4, 8]);
    expect(store.getState().outputs.dispatch_b1).toMatchObject({
      cursor: 10,
      total: 10,
      done: false,
      error: null,
    });
    expect(store.getState().outputs.dispatch_b1?.pages.join('')).toBe('abcdefghij');

    // 读到末尾但 worker 还在跑：间隔轮询
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS - 1);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(3);
    output.text += 'KLM';
    await vi.advanceTimersByTimeAsync(1);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(4);
    expect(api.readWorkerOutput).toHaveBeenLastCalledWith({
      dispatchId: 'dispatch_b1',
      cursor: 10,
    });
    expect(store.getState().outputs.dispatch_b1?.pages.join('')).toBe('abcdefghijKLM');

    // settle 后读完最后一页就停
    output.text += 'NOP';
    output.done = true;
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS);
    expect(store.getState().outputs.dispatch_b1).toMatchObject({ cursor: 16, done: true });
    expect(vi.getTimerCount()).toBe(0);
    const calls = api.readWorkerOutput.mock.calls.length;
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS * 5);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not done while settled output is still unread', async () => {
    const { api, output } = fakeApi();
    output.text = 'abcdef';
    output.pageChars = 4;
    output.done = true;
    const store = createOrchestrationStore(api);
    store.getState().watchOutput('dispatch_a1');
    await flush();
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(2);
    expect(store.getState().outputs.dispatch_a1).toMatchObject({ cursor: 6, done: true });
  });

  it('stops polling when the last watcher leaves and resumes from the cursor', async () => {
    const { api, output } = fakeApi();
    output.text = 'abc';
    const store = createOrchestrationStore(api);
    const first = store.getState().watchOutput('dispatch_b1');
    const second = store.getState().watchOutput('dispatch_b1');
    await flush();
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(1);

    first();
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    second();
    second();
    // 最后一个观察者离开时立即取消挂起的轮询
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS * 3);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(2);

    output.text += 'de';
    store.getState().watchOutput('dispatch_b1');
    await flush();
    expect(api.readWorkerOutput).toHaveBeenLastCalledWith({ dispatchId: 'dispatch_b1', cursor: 3 });
    expect(store.getState().outputs.dispatch_b1?.pages.join('')).toBe('abcde');
  });

  it('stops on errors until retried', async () => {
    const { api, output } = fakeApi();
    output.error = 'agent host is not connected';
    const store = createOrchestrationStore(api);
    store.getState().watchOutput('dispatch_b1');
    await flush();
    expect(store.getState().outputs.dispatch_b1?.error).toBe('agent host is not connected');
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS * 3);
    expect(api.readWorkerOutput).toHaveBeenCalledTimes(1);

    output.error = '';
    output.text = 'hello';
    store.getState().retryOutput('dispatch_b1');
    await flush();
    expect(store.getState().outputs.dispatch_b1).toMatchObject({ error: null, cursor: 5 });
  });

  it('starts over when the output got shorter than the cursor', async () => {
    const { api, output } = fakeApi();
    output.text = 'old output that was long';
    const store = createOrchestrationStore(api);
    store.getState().watchOutput('dispatch_b1');
    await flush();

    // Main 重启后按 jsonl 重建投影：总长度变短，旧 cursor 失效
    output.text = 'rebuilt';
    await vi.advanceTimersByTimeAsync(OUTPUT_POLL_MS);
    expect(store.getState().outputs.dispatch_b1).toMatchObject({ cursor: 7, total: 7 });
    expect(store.getState().outputs.dispatch_b1?.pages.join('')).toBe('rebuilt');
  });

  it('checks a finished output again when the snapshot changes', async () => {
    const { api, output, state, emit } = fakeApi();
    output.text = 'report 1\n';
    output.done = true;
    const store = createOrchestrationStore(api);
    store.getState().watchWorkspace('ws');
    store.getState().watchOutput('dispatch_b1');
    await flush();
    expect(store.getState().outputs.dispatch_b1?.done).toBe(true);
    const calls = api.readWorkerOutput.mock.calls.length;

    // send_to_worker 之后 worker 在同一次尝试里继续产出
    output.text += 'follow-up\n';
    output.done = false;
    state.view = view({
      messages: [...view().messages, message('m9', 'dispatch_b1', 99, 'instruction')],
    });
    emit('ws');
    await flush();
    expect(api.readWorkerOutput.mock.calls.length).toBe(calls + 1);
    expect(store.getState().outputs.dispatch_b1).toMatchObject({ done: false });
    expect(store.getState().outputs.dispatch_b1?.pages.join('')).toBe('report 1\nfollow-up\n');
  });

  it('keeps only the most recent characters of a huge output', async () => {
    const { api, output } = fakeApi();
    output.pageChars = 4;
    output.text = 'aaaabbbbccccdddd';
    const store = createOrchestrationStore(api, { maxOutputChars: 6 });
    store.getState().watchOutput('dispatch_b1');
    await flush();
    const entry = store.getState().outputs.dispatch_b1;
    expect(entry).toMatchObject({ cursor: 16, dropped: 10 });
    expect(entry?.pages.join('')).toBe('ccdddd');
  });
});

describe('createOrchestrationStore · diffs', () => {
  it('caches the diff of a dispatch and reloads it on demand', async () => {
    const { api } = fakeApi();
    const store = createOrchestrationStore(api);
    const loading = store.getState().loadDiff('dispatch_a1');
    expect(store.getState().diffs.dispatch_a1).toEqual({ status: 'loading' });
    await loading;
    expect(store.getState().diffs.dispatch_a1).toMatchObject({
      status: 'ready',
      refreshing: false,
      data: { branch: 'fynvra/dispatch_a1', files: ['a.ts'] },
    });

    await store.getState().loadDiff('dispatch_a1');
    expect(api.reviewDiff).toHaveBeenCalledTimes(1);

    const reload = store.getState().loadDiff('dispatch_a1', { force: true });
    expect(store.getState().diffs.dispatch_a1).toMatchObject({ status: 'ready', refreshing: true });
    await reload;
    expect(api.reviewDiff).toHaveBeenCalledTimes(2);
    expect(store.getState().diffs.dispatch_a1).toMatchObject({ refreshing: false });
  });

  it('records errors and retries them on the next load', async () => {
    const { api } = fakeApi();
    api.reviewDiff.mockResolvedValueOnce({
      ok: false,
      error: 'the worktree of dispatch dispatch_a1 was already cleaned up',
    } as never);
    const store = createOrchestrationStore(api);
    await store.getState().loadDiff('dispatch_a1');
    expect(store.getState().diffs.dispatch_a1).toEqual({
      status: 'error',
      error: 'the worktree of dispatch dispatch_a1 was already cleaned up',
    });
    await store.getState().loadDiff('dispatch_a1');
    expect(store.getState().diffs.dispatch_a1?.status).toBe('ready');
  });
});
