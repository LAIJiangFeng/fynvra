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

async function coldRecovery(recoveryRequired: boolean) {
  const env = await setup();
  const store = createSessionsStore(env.api, { schedule: (flush) => flush() });
  store.setState({ workspaceId: 'ws' });
  expect(store.getState().runtimeBySession[env.id]).toBeUndefined();
  vi.spyOn(env.api, 'history').mockResolvedValueOnce({
    ok: true,
    messages: [],
    contextRuntimeSeq: 7,
    contextRecovery: { recoveryRequired },
  });
  await store.getState().selectSession(env.id);
  return { ...env, store };
}

describe('cold checkpoint recovery hydration', () => {
  it('offers recovery by ID from a fresh store without inventing loaded context or resending old input', async () => {
    const { store, id, retry, prompt } = await coldRecovery(true);
    expect(store.getState().runtimeBySession[id]).toMatchObject({
      recoveryRequired: true,
      contextSeq: 7,
    });
    expect(store.getState().runtimeBySession[id].contextRuntime).toBeUndefined();
    expect(store.getState().runtimeBySession[id].pendingPromptCount).toBeUndefined();
    expect(store.getState().messagesBySession[id]).toEqual([]);
    await store.getState().loadSessions('ws');
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(true);
    await store.getState().retryCompaction(id);
    expect(retry).toHaveBeenCalledExactlyOnceWith(id);
    expect(store.getState().recoveringCompaction[id]).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not offer recovery for an unblocked checkpoint', async () => {
    const { store, id, retry, prompt } = await coldRecovery(false);
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(false);
    expect(store.getState().runtimeBySession[id].contextRuntime).toBeUndefined();
    await store.getState().retryCompaction(id);
    expect(retry).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects a delayed blocked hint after live recovery completes', async () => {
    const { store, id, api, retry } = await coldRecovery(true);
    const history = deferred<Awaited<ReturnType<SessionsApi['history']>>>();
    vi.mocked(api.history).mockReturnValueOnce(history.promise);
    const selecting = store.getState().selectSession(id);
    store.getState().receiveEvent({
      sessionId: id,
      event: { seq: 8, type: 'context_runtime', snapshot: snapshot() },
    });
    history.resolve({
      ok: true,
      messages: [],
      contextRuntimeSeq: 7,
      contextRecovery: { recoveryRequired: true },
    });
    await selecting;
    expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(false);
    expect(store.getState().runtimeBySession[id].contextSeq).toBe(8);
    await store.getState().retryCompaction(id);
    expect(retry).not.toHaveBeenCalled();
  });

  it('rejects older history requests even when no live event intervened', async () => {
    const { store, id, api } = await coldRecovery(true);
    const history = deferred<Awaited<ReturnType<SessionsApi['history']>>>();
    vi.mocked(api.history).mockReturnValueOnce(history.promise);
    const selecting = store.getState().selectSession(id);
    vi.mocked(api.history).mockResolvedValueOnce({
      ok: true,
      messages: [],
      contextRuntimeSeq: 9,
      contextRecovery: { recoveryRequired: false },
    });
    await store.getState().selectSession(id);
    history.resolve({
      ok: true,
      messages: [],
      contextRuntimeSeq: 7,
      contextRecovery: { recoveryRequired: true },
    });
    await selecting;
    expect(store.getState().runtimeBySession[id]).toMatchObject({
      recoveryRequired: false,
      contextSeq: 9,
    });
  });

  it('keeps recovery in progress through an intermediate settled event until the runtime unlocks', async () => {
    const { store, id, prompt } = await coldRecovery(true);
    store.getState().receiveEvent({
      sessionId: id,
      event: {
        seq: 8,
        type: 'error',
        source: 'host',
        message: 'previous load failed',
      },
    });
    await store.getState().send('new local message');
    await store.getState().retryCompaction(id);
    expect(store.getState().runtimeBySession[id].error).toBeUndefined();
    store.getState().receiveEvent({
      sessionId: id,
      event: {
        seq: 9,
        type: 'context_runtime',
        snapshot: snapshot({ recoveryRequired: true }),
      },
    });
    store
      .getState()
      .receiveEvent({ sessionId: id, event: { seq: 10, type: 'agent_settled', aborted: false } });
    expect(store.getState().recoveringCompaction[id]).toBe(true);
    store
      .getState()
      .receiveEvent({
        sessionId: id,
        event: { seq: 11, type: 'context_runtime', snapshot: snapshot() },
      });
    expect(store.getState().recoveringCompaction[id]).toBeUndefined();
    expect(store.getState().runtimeBySession[id].status).toBe('idle');
    expect(store.getState().runtimeBySession[id].error).toBeUndefined();
    expect(store.getState().pausedQueues[id]).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each(['success', 'load-error', 'status-error'] as const)(
    'settles recovery without a compaction_start on %s and keeps the local queue held',
    async (result) => {
      const { store, id, api, retry, prompt } = await coldRecovery(true);
      await store.getState().send('new local message');
      await store.getState().retryCompaction(id);
      expect(store.getState().recoveringCompaction[id]).toBe(true);
      if (result === 'success') {
        store.getState().receiveEvent({
          sessionId: id,
          event: { seq: 8, type: 'context_runtime', snapshot: snapshot() },
        });
        store.getState().receiveEvent({
          sessionId: id,
          event: { seq: 9, type: 'agent_settled', aborted: false },
        });
        expect(store.getState().runtimeBySession[id].recoveryRequired).toBe(false);
      } else if (result === 'load-error') {
        store.getState().receiveEvent({
          sessionId: id,
          event: {
            seq: 8,
            type: 'error',
            source: 'host',
            message: 'Could not load original session',
          },
        });
        expect(store.getState().runtimeBySession[id].error).toBe('Could not load original session');
      } else {
        const list = await api.list('ws');
        if (!list.ok) throw new Error(list.error);
        vi.spyOn(api, 'list').mockResolvedValueOnce({
          ok: true,
          sessions: list.sessions.map((session) => ({ ...session, status: 'error' })),
        });
        await store.getState().loadSessions('ws');
        expect(store.getState().runtimeBySession[id].status).toBe('error');
      }
      expect(store.getState().recoveringCompaction[id]).toBeUndefined();
      expect(store.getState().runtimeBySession[id].compaction).toBeUndefined();
      expect(store.getState().pausedQueues[id]).toBe(true);
      expect(store.getState().queuedBySession[id]?.map((item) => item.text)).toEqual([
        'new local message',
      ]);
      expect(retry).toHaveBeenCalledExactlyOnceWith(id);
      expect(prompt).not.toHaveBeenCalled();
    }
  );
});

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
      expect(store.getState().pausedQueues[id]).toBeUndefined();
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

  it.each([false, true])(
    'drains after an intermediate model failure retries successfully (batched: %s)',
    async (batched) => {
      let flush = () => {};
      const { store, id, emit, prompt, queue } = await setup(
        batched
          ? (callback) => {
              flush = callback;
            }
          : undefined
      );
      await store.getState().send('original');
      emit({ type: 'message_end', role: 'user', text: 'original' });
      await store.getState().send('queued');
      emit({
        type: 'message_end',
        role: 'assistant',
        text: '',
        stopReason: 'error',
        errorMessage: 'transient failure',
      });
      emit({
        type: 'retry',
        state: { kind: 'model', phase: 'backoff', attempt: 1, maxAttempts: 3, delayMs: 1_000 },
      });
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
      emit({ type: 'message_end', role: 'assistant', text: 'recovered', stopReason: 'stop' });
      emit({ type: 'agent_settled', aborted: false });
      flush();
      expect(store.getState().pausedQueues[id]).toBeUndefined();
      expect(store.getState().runtimeBySession[id].error).toBeUndefined();
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenLastCalledWith({ sessionId: id, text: 'queued' });
      expect(queue()).toEqual([]);
    }
  );

  it('holds the queue when model retries are exhausted', async () => {
    const { store, id, emit, prompt, queue } = await setup();
    await store.getState().send('original');
    emit({ type: 'message_end', role: 'user', text: 'original' });
    await store.getState().send('queued');
    emit({ type: 'message_end', role: 'assistant', text: '', stopReason: 'error' });
    emit({
      type: 'retry',
      state: { kind: 'model', phase: 'backoff', attempt: 1, maxAttempts: 1, delayMs: 1_000 },
    });
    emit({
      type: 'message_end',
      role: 'assistant',
      text: '',
      stopReason: 'error',
      errorMessage: 'final failure',
    });
    emit({
      type: 'retry',
      state: {
        kind: 'model',
        phase: 'finished',
        attempt: 1,
        maxAttempts: 1,
        delayMs: 0,
        success: false,
      },
    });
    emit({ type: 'error', source: 'model', message: 'final failure' });
    emit({ type: 'agent_settled', aborted: false });
    expect(store.getState().runtimeBySession[id].error).toBe('final failure');
    expect(store.getState().pausedQueues[id]).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(queue()).toEqual(['queued']);
  });

  it.each(['stop', 'compaction'] as const)(
    'a successful model retry cannot release an existing %s hold',
    async (reason) => {
      const { store, id, emit, prompt, queue } = await setup();
      await store.getState().send('original');
      emit({ type: 'message_end', role: 'user', text: 'original' });
      await store.getState().send('queued');
      emit({ type: 'message_end', role: 'assistant', text: '', stopReason: 'error' });
      if (reason === 'stop') await store.getState().abort();
      else {
        emit({ type: 'compaction', state: operation({ phase: 'failed' }) });
        emit({ type: 'context_runtime', snapshot: snapshot() });
      }
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
      emit({ type: 'message_end', role: 'assistant', text: 'recovered', stopReason: 'stop' });
      emit({ type: 'agent_settled', aborted: false });
      expect(store.getState().pausedQueues[id]).toBe(true);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(queue()).toEqual(['queued']);
    }
  );

  it.each([false, true])(
    'restores a rejected draft despite older pending input (old user message: %s)',
    async (oldUserMessage) => {
      const { store, id, emit, prompt } = await setup();
      const ack = deferred<IpcResult>();
      prompt.mockReturnValueOnce(ack.promise);
      store.getState().setDraft(id, 'new input');
      const sending = store.getState().send('new input');
      emit({
        type: 'context_runtime',
        snapshot: snapshot({ recoveryRequired: true, pendingPromptCount: 1 }),
      });
      if (oldUserMessage) emit({ type: 'message_end', role: 'user', text: 'older pending input' });
      ack.resolve({ ok: false, error: 'Context recovery required' });
      expect(await sending).toBe(false);
      expect(store.getState().drafts[id]).toBe('new input');
      expect(
        store.getState().messagesBySession[id].some((message) => message.text === 'new input')
      ).toBe(false);
      if (oldUserMessage)
        expect(
          store
            .getState()
            .messagesBySession[id].some((message) => message.text === 'older pending input')
        ).toBe(true);
      expect(store.getState().runtimeBySession[id].pendingPromptCount).toBe(1);
      expect(store.getState().pausedQueues[id]).toBe(true);
    }
  );

  it('restores a rejected queued message despite older backend pending input', async () => {
    const { store, id, emit, prompt, queue } = await setup();
    await store.getState().send('original');
    emit({ type: 'message_end', role: 'user', text: 'original' });
    await store.getState().send('queued');
    const ack = deferred<IpcResult>();
    prompt.mockReturnValueOnce(ack.promise);
    emit({ type: 'agent_settled', aborted: false });
    emit({
      type: 'context_runtime',
      snapshot: snapshot({ recoveryRequired: true, pendingPromptCount: 1 }),
    });
    ack.resolve({ ok: false, error: 'Context recovery required' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue()).toEqual(['queued']);
    expect(
      store.getState().messagesBySession[id].some((message) => message.text === 'queued')
    ).toBe(false);
    expect(store.getState().pausedQueues[id]).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('matching history confirmation still outweighs a late failed ACK', async () => {
    const { store, id, api, prompt } = await setup();
    const ack = deferred<IpcResult>();
    prompt.mockReturnValueOnce(ack.promise);
    const sending = store.getState().send('delivered input');
    vi.spyOn(api, 'history').mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          id: 'history-user',
          sessionId: id,
          role: 'user',
          text: 'delivered input',
          createdAt: 2_000,
          toolCalls: [],
          streaming: false,
        },
      ],
    });
    await store.getState().selectSession(id);
    ack.resolve({ ok: false, error: 'late transport error' });
    expect(await sending).toBe(true);
    expect(store.getState().drafts[id]).toBeUndefined();
    expect(store.getState().messagesBySession[id]).toHaveLength(1);
    expect(store.getState().messagesBySession[id][0].id).toBe('history-user');
  });

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

  it('accepts the same operation ID from a newly loaded instance during explicit recovery', async () => {
    const { store, id, emit, retry } = await failed();
    await store.getState().loadSessions('ws');
    expect(store.getState().runtimeBySession[id].contextRuntime).toBeUndefined();
    await store.getState().retryCompaction(id);
    const restarted = operation({ startedAt: 700_000, deadlineAt: 1_300_000 });
    emit({ type: 'compaction', state: restarted });
    emit({
      type: 'context_runtime',
      snapshot: snapshot({ compaction: restarted, recoveryRequired: true, pendingPromptCount: 1 }),
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith(id);
    expect(store.getState().runtimeBySession[id]).toMatchObject({
      status: 'running',
      compaction: restarted,
      contextRuntime: { compaction: restarted },
    });
    expect(store.getState().recoveringCompaction[id]).toBe(true);
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
