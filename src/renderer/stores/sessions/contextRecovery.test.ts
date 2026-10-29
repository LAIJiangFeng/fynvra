import type { CompactionState, ContextRuntimeSnapshot, FynvraSessionEventBody } from '@fynvra/core';
import type { IpcResult } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createMockSessionsApi, type SessionsApi } from '../../lib/api/sessions';
import { createSessionsStore } from './createSessionsStore';
import { selectReplySuggestionOf } from './selectors';

const operation = (patch: Partial<CompactionState> = {}): CompactionState => ({
  operationId: 'compact-1',
  reason: 'threshold',
  phase: 'running',
  startedAt: 1_000,
  deadlineAt: 601_000,
  attempt: 1,
  maxAttempts: 3,
  ...patch,
});
const snapshot = (patch: Partial<ContextRuntimeSnapshot> = {}): ContextRuntimeSnapshot => ({
  configuredStrategy: 'native',
  effectiveStrategy: 'native',
  compactionTimeoutMs: 600_000,
  context: {
    tokens: 90_000,
    contextWindow: 100_000,
    source: 'sdk',
    compactionThresholdTokens: 84_000,
  },
  recoveryRequired: false,
  pendingPromptCount: 0,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(schedule: (flush: () => void) => void = (flush) => flush()) {
  const api = createMockSessionsApi();
  const created = await api.create({ workspaceId: 'ws', roleId: 'worker' });
  if (!created.ok) throw new Error(created.error);
  const id = created.session.id;
  const prompt = vi.spyOn(api, 'prompt').mockResolvedValue({ ok: true });
  const steer = vi.spyOn(api, 'steer').mockResolvedValue({ ok: true });
  const retry = vi.spyOn(api, 'retryCompaction').mockResolvedValue({ ok: true });
  vi.spyOn(api, 'abort').mockResolvedValue({ ok: true });
  const store = createSessionsStore(api, { schedule, now: () => 2_000 });
  await store.getState().loadSessions('ws');
  await store.getState().selectSession(id);
  let seq = 0;
  const emit = (event: FynvraSessionEventBody) =>
    store.getState().receiveEvent({ sessionId: id, event: { ...event, seq: ++seq } });
  const queue = () => store.getState().queuedBySession[id]?.map((item) => item.text) ?? [];
  return { api, id, store, prompt, steer, retry, emit, queue };
}
async function failed(patch: Partial<CompactionState> = {}) {
  const env = await setup();
  const { store, id, emit } = env;
  await store.getState().send('original');
  emit({ type: 'compaction', state: operation() });
  emit({
    type: 'context_runtime',
    snapshot: snapshot({ compaction: operation(), pendingPromptCount: 1 }),
  });
  await store.getState().send('queued');
  const cancelled = operation({
    phase: 'cancelled',
    cancelSource: 'timeout',
    endedAt: 601_000,
    ...patch,
  });
  emit({ type: 'compaction', state: cancelled });
  emit({
    type: 'context_runtime',
    snapshot: snapshot({ compaction: cancelled, pendingPromptCount: 1, recoveryRequired: true }),
  });
  emit({ type: 'agent_settled', aborted: true });
  expect(store.getState().pausedQueues[id]).toBe(true);
  return env;
}

describe('context recovery and renderer queue ownership', () => {
  it.each([
    { phase: 'failed', cancelSource: 'exception' },
    { phase: 'cancelled', cancelSource: 'user' },
    { phase: 'cancelled', cancelSource: 'timeout' },
  ] as const)(
    'preserves pending input and local queue after $phase / $cancelSource',
    async (patch) => {
      const { store, id, prompt, queue } = await failed(patch);
      store.getState().resumeQueue(id);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(queue()).toEqual(['queued']);
      expect(store.getState().runtimeBySession[id]).toMatchObject({
        recoveryRequired: true,
        pendingPromptCount: 1,
        compaction: patch,
      });
    }
  );

  it.each(['error', 'aborted'])(
    'a final assistant %s pauses the queue even without a separate error event',
    async (stopReason) => {
      const { store, id, emit, prompt, queue } = await setup();
      await store.getState().send('original');
      emit({ type: 'message_end', role: 'user', text: 'original' });
      await store.getState().send('queued');
      emit({
        type: 'message_end',
        role: 'assistant',
        text: '',
        stopReason,
        errorMessage: 'safe failure',
      });
      emit({ type: 'agent_settled', aborted: false });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(queue()).toEqual(['queued']);
      expect(store.getState().pausedQueues[id]).toBe(true);
      if (stopReason === 'error')
        expect(store.getState().runtimeBySession[id].error).toBe('safe failure');
      store.getState().resumeQueue(id);
      expect(prompt).toHaveBeenCalledTimes(2);
    }
  );

  it('flushes buffered delivery evidence before handling a late failed prompt ACK', async () => {
    const { store, id, emit, prompt, queue } = await setup(() => {});
    const ack = deferred<IpcResult>();
    prompt.mockReturnValueOnce(ack.promise);
    const sending = store.getState().send('original');
    await store.getState().send('queued');
    emit({ type: 'message_end', role: 'user', text: 'original' });
    emit({ type: 'agent_settled', aborted: false });
    ack.resolve({ ok: false, error: 'late transport error' });
    expect(await sending).toBe(true);
    expect(store.getState().drafts[id]).toBeUndefined();
    expect(
      store.getState().messagesBySession[id].filter((message) => message.text === 'original')
    ).toHaveLength(1);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(queue()).toEqual([]);
  });

  it('does not start a second recovery while the first ACK is pending after Stop', async () => {
    const { store, id, emit, retry } = await failed();
    const ack = deferred<IpcResult>();
    retry.mockReturnValueOnce(ack.promise);
    const recovering = store.getState().retryCompaction(id);
    await store.getState().abort();
    emit({ type: 'agent_settled', aborted: true });
    await store.getState().retryCompaction(id);
    expect(retry).toHaveBeenCalledTimes(1);
    ack.resolve({ ok: true });
    await recovering;
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(store.getState().pausedQueues[id]).toBe(true);
  });

  it('does not release a queue while Stop is still in flight', async () => {
    const { store, api, id, emit, prompt, queue } = await setup();
    await store.getState().send('original');
    await store.getState().send('queued');
    const ack = deferred<IpcResult>();
    vi.mocked(api.abort).mockReturnValueOnce(ack.promise);
    const stopping = store.getState().abort();
    emit({ type: 'agent_settled', aborted: true });
    store.getState().resumeQueue(id);
    expect(store.getState().pausedQueues[id]).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(queue()).toEqual(['queued']);
    ack.resolve({ ok: true });
    await stopping;
    store.getState().resumeQueue(id);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('a failed recovery ACK after navigation does not show an error in the other session', async () => {
    const { store, api, id, retry, queue } = await failed();
    const other = await api.create({ workspaceId: 'ws', roleId: 'worker' });
    if (!other.ok) throw new Error(other.error);
    const ack = deferred<IpcResult>();
    retry.mockReturnValueOnce(ack.promise);
    const recovering = store.getState().retryCompaction(id);
    await store.getState().selectSession(other.session.id, 'ws');
    ack.resolve({ ok: false, error: 'old session failure' });
    await recovering;
    expect(store.getState().notice).toBeNull();
    expect(store.getState().activeSessionId).toBe(other.session.id);
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(true);
    expect(queue()).toEqual(['queued']);
  });

  it('an unloaded terminal session clears an accepted recovery spinner without releasing the queue', async () => {
    const { store, id, retry, queue } = await failed();
    await store.getState().retryCompaction(id);
    expect(store.getState().recoveringCompaction[id]).toBe(true);
    await store.getState().loadSessions('ws');
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(store.getState().runtimeBySession[id].contextRuntime).toBeUndefined();
    expect(queue()).toEqual(['queued']);
    await store.getState().retryCompaction(id);
    expect(retry).toHaveBeenCalledTimes(2);
  });
  it('does not pause the queue when Magic Context cancels the native SDK hook', async () => {
    const { store, id, emit, prompt, queue } = await setup();
    await store.getState().send('original');
    emit({
      type: 'context_runtime',
      snapshot: snapshot({
        configuredStrategy: 'magic-context',
        effectiveStrategy: 'magic-context',
      }),
    });
    await store.getState().send('queued');
    emit({ type: 'compaction', state: operation() });
    const cancelled = operation({ phase: 'cancelled', cancelSource: 'sdk' });
    emit({ type: 'compaction', state: cancelled });
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(false);
    expect(store.getState().pausedQueues[id]).toBeUndefined();
    emit({
      type: 'context_runtime',
      snapshot: snapshot({
        configuredStrategy: 'magic-context',
        effectiveStrategy: 'magic-context',
        compaction: cancelled,
      }),
    });
    emit({ type: 'agent_settled', aborted: false });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(queue()).toEqual([]);
  });

  it('keeps queued/draft steers out of the SDK during compaction', async () => {
    const { store, id, emit, prompt, steer, queue } = await setup();
    await store.getState().send('original');
    emit({ type: 'compaction', state: operation() });
    store.getState().setDraft(id, 'later');
    expect(await store.getState().steer(id)).toBe(true);
    expect(queue()).toEqual(['later']);
    const queued = store.getState().queuedBySession[id][0];
    expect(await store.getState().steer(id, queued.id)).toBe(false);
    expect(queue()).toEqual(['later']);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
  });

  it('retries by id only, preserves the original echo, and resumes local messages exactly once after explicit recovery', async () => {
    const { store, id, emit, prompt, retry, queue } = await failed();
    const ack = deferred<IpcResult>();
    retry.mockReturnValueOnce(ack.promise);
    const request = store.getState().retryCompaction(id);
    await store.getState().retryCompaction(id);
    expect(retry).toHaveBeenCalledExactlyOnceWith(id);
    expect(
      store.getState().messagesBySession[id].filter((message) => message.text === 'original')
    ).toHaveLength(1);
    ack.resolve({ ok: true });
    await request;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store.getState().recoveringCompaction[id]).toBe(true);
    const next = operation({ operationId: 'compact-2', startedAt: 700_000 });
    emit({ type: 'compaction', state: next });
    emit({ type: 'compaction', state: { ...next, phase: 'succeeded' } });
    emit({
      type: 'context_runtime',
      snapshot: snapshot({
        compaction: { ...next, phase: 'succeeded' },
        recoveryRequired: true,
        pendingPromptCount: 1,
      }),
    });
    store.getState().resumeQueue(id);
    expect(prompt).toHaveBeenCalledTimes(1);
    // The backend, not Renderer, resubmits its pending original input.
    emit({ type: 'message_end', role: 'user', text: 'original' });
    emit({ type: 'message_end', role: 'assistant', text: 'done', stopReason: 'stop' });
    emit({ type: 'context_runtime', snapshot: snapshot() });
    emit({ type: 'agent_settled', aborted: false });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(queue()).toEqual(['queued']);
    store.getState().resumeQueue(id);
    store.getState().resumeQueue(id);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenLastCalledWith({ sessionId: id, text: 'queued' });
    expect(queue()).toEqual([]);
  });

  it('failed recovery ACK and a second Stop retain failure information and the local queue', async () => {
    const { store, id, retry, prompt, emit, queue } = await failed();
    retry.mockResolvedValueOnce({ ok: false, error: 'safe failure' });
    await store.getState().retryCompaction(id);
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(store.getState().notice).toContain('safe failure');
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(true);
    const ack = deferred<IpcResult>();
    retry.mockReturnValueOnce(ack.promise);
    const attempt = store.getState().retryCompaction(id);
    await store.getState().abort();
    emit({ type: 'agent_settled', aborted: true });
    ack.resolve({ ok: true });
    await attempt;
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(queue()).toEqual(['queued']);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('retains a failed queued delivery on partial recovery without retry loops', async () => {
    const { store, id, prompt, emit, queue } = await failed();
    await store.getState().retryCompaction(id);
    emit({ type: 'context_runtime', snapshot: snapshot() });
    emit({ type: 'agent_settled', aborted: false });
    prompt.mockResolvedValueOnce({ ok: false, error: 'not accepted' });
    store.getState().resumeQueue(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue()).toEqual(['queued']);
    expect(store.getState().pausedQueues[id]).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
    emit({ type: 'agent_settled', aborted: false });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('worker unload forgets actual engine/context, not the recovery action or pending echo', async () => {
    const { store, id, retry, queue } = await failed();
    await store.getState().loadSessions('ws'); // unloaded mock summary has no runtime snapshot
    const runtime = store.getState().runtimeBySession[id];
    expect(runtime.contextRuntime).toBeUndefined();
    expect(runtime.recoveryRequired).toBe(true);
    expect(runtime.pendingPromptCount).toBe(1);
    expect(runtime.compaction?.phase).toBe('cancelled');
    await store.getState().retryCompaction(id);
    expect(retry).toHaveBeenCalledExactlyOnceWith(id);
    expect(queue()).toEqual(['queued']);
  });

  it('late history/list snapshots do not overwrite live compaction or restart elapsed time', async () => {
    const { store, id, api, emit } = await setup();
    const history = deferred<Awaited<ReturnType<SessionsApi['history']>>>();
    vi.spyOn(api, 'history').mockReturnValueOnce(history.promise);
    const selecting = store.getState().selectSession(id);
    emit({ type: 'compaction', state: operation() });
    emit({ type: 'context_runtime', snapshot: snapshot({ compaction: operation() }) });
    history.resolve({ ok: true, messages: [], contextRuntime: snapshot(), contextRuntimeSeq: 0 });
    await selecting;
    expect(store.getState().runtimeBySession[id].compaction?.startedAt).toBe(1_000);
    const list = deferred<Awaited<ReturnType<SessionsApi['list']>>>();
    vi.spyOn(api, 'list').mockReturnValueOnce(list.promise);
    const loading = store.getState().loadSessions('ws');
    emit({ type: 'compaction', state: operation({ phase: 'backoff', attempt: 2 }) });
    list.resolve({ ok: true, sessions: [] });
    await loading;
    expect(store.getState().runtimeBySession[id].compaction).toMatchObject({
      startedAt: 1_000,
      attempt: 2,
      phase: 'backoff',
    });
  });

  it('a stale list snapshot cannot stop newer live progress through its idle status', async () => {
    const { store, id, api, emit } = await setup();
    const list = await api.list('ws');
    if (!list.ok) throw new Error(list.error);
    emit({ type: 'compaction', state: operation() });
    emit({ type: 'context_runtime', snapshot: snapshot({ compaction: operation() }) });
    vi.spyOn(api, 'list').mockResolvedValueOnce({
      ok: true,
      sessions: list.sessions.map((session) => ({
        ...session,
        status: 'idle',
        contextRuntime: snapshot(),
        contextRuntimeSeq: 0,
      })),
    });
    await store.getState().loadSessions('ws');
    expect(store.getState().runtimeBySession[id]).toMatchObject({
      status: 'running',
      compaction: { phase: 'running', startedAt: 1_000 },
    });
  });

  it('late unloaded history cannot erase a newer list snapshot when no live event arrived', async () => {
    const { store, id, api } = await setup();
    const list = await api.list('ws');
    if (!list.ok) throw new Error(list.error);
    const history = deferred<Awaited<ReturnType<SessionsApi['history']>>>();
    vi.spyOn(api, 'history').mockReturnValueOnce(history.promise);
    const selecting = store.getState().selectSession(id);
    vi.spyOn(api, 'list').mockResolvedValueOnce({
      ok: true,
      sessions: list.sessions.map((session) => ({
        ...session,
        status: 'running',
        contextRuntime: snapshot({ compaction: operation() }),
        contextRuntimeSeq: 5,
      })),
    });
    await store.getState().loadSessions('ws');
    history.resolve({ ok: true, messages: [] });
    await selecting;
    expect(store.getState().runtimeBySession[id]).toMatchObject({
      contextSeq: 5,
      status: 'running',
      compaction: { phase: 'running' },
      contextRuntime: { effectiveStrategy: 'native' },
    });
  });

  it('metadata after a normal short turn preserves suggestions and does not mark the session working', async () => {
    const { store, id, emit } = await setup();
    emit({ type: 'agent_settled', aborted: false });
    store.setState({ replySuggestions: { [id]: { sessionId: id, roundId: 1, text: 'next' } } });
    emit({ type: 'context_runtime', snapshot: snapshot() });
    emit({
      type: 'retry',
      state: {
        kind: 'model',
        phase: 'finished',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 0,
        success: true,
      },
    });
    expect(store.getState().runtimeBySession[id].status).toBe('idle');
    expect(selectReplySuggestionOf(id)(store.getState())?.text).toBe('next');
  });
});
