import type { CompactionState, ContextRuntimeSnapshot, FynvraSessionEventBody } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  applyContextRuntime,
  type ChatProjection,
  emptyProjection,
  reduceSessionEvent,
  syncSessionStatuses,
} from './reducer';

const operation: CompactionState = {
  operationId: 'op-1',
  reason: 'threshold',
  phase: 'running',
  startedAt: 1_000,
  deadlineAt: 601_000,
  attempt: 1,
  maxAttempts: 3,
};
const snapshot: ContextRuntimeSnapshot = {
  configuredStrategy: 'native',
  effectiveStrategy: 'native',
  compactionTimeoutMs: 600_000,
  context: { tokens: 200_000, contextWindow: 256_000, source: 'sdk' },
  recoveryRequired: false,
  pendingPromptCount: 0,
};
function apply(state: ChatProjection, seq: number, event: FynvraSessionEventBody) {
  return reduceSessionEvent(state, { sessionId: 's', event: { ...event, seq } }, 4_000);
}

describe('context metadata projection', () => {
  it('hydrates checkpoint recovery independently of loaded runtime and enforces its watermark', () => {
    let state = applyContextRuntime(emptyProjection(), 's', undefined, 7, true);
    expect(state.runtimeBySession.s).toMatchObject({ recoveryRequired: true, contextSeq: 7 });
    expect(state.runtimeBySession.s.contextRuntime).toBeUndefined();
    expect(state.runtimeBySession.s.pendingPromptCount).toBeUndefined();
    state = applyContextRuntime(state, 's', undefined); // ordinary unloaded summary
    expect(state.runtimeBySession.s.recoveryRequired).toBe(true);
    expect(apply(state, 6, { type: 'context_runtime', snapshot })).toBe(state);
    state = apply(state, 8, { type: 'context_runtime', snapshot });
    expect(applyContextRuntime(state, 's', undefined, 7, true)).toBe(state);
    expect(applyContextRuntime(state, 's', undefined, undefined, true)).toBe(state);
    expect(state.runtimeBySession.s.recoveryRequired).toBe(false);
  });

  it('an actual loaded snapshot takes precedence over a checkpoint hint', () => {
    const state = applyContextRuntime(emptyProjection(), 's', snapshot, 5, true);
    expect(state.runtimeBySession.s.recoveryRequired).toBe(false);
    expect(state.runtimeBySession.s.contextRuntime).toEqual(snapshot);
  });

  it('uses the event timestamp across retries, without altering the conversation activity sequence', () => {
    let state = apply(emptyProjection(), 1, {
      type: 'message_end',
      role: 'user',
      text: 'question',
    });
    state = apply(state, 2, { type: 'compaction', state: operation });
    state = apply(state, 3, {
      type: 'compaction',
      state: { ...operation, phase: 'backoff', attempt: 2 },
    });
    state = apply(state, 4, {
      type: 'retry',
      state: { kind: 'summarization', phase: 'backoff', attempt: 2, maxAttempts: 3, delayMs: 500 },
    });
    expect(state.runtimeBySession.s).toMatchObject({
      activitySeq: 1,
      lastSeq: 4,
      compaction: { startedAt: 1_000, attempt: 2 },
      retry: { attempt: 2 },
    });
  });

  it.each(['settled', 'error', 'status', 'history'] as const)(
    '%s clears active progress; late events cannot revive that operation',
    (terminal) => {
      let state = apply(emptyProjection(), 1, { type: 'compaction', state: operation });
      state = apply(state, 2, {
        type: 'retry',
        state: { kind: 'model', phase: 'running', attempt: 1, maxAttempts: 3, delayMs: 0 },
      });
      if (terminal === 'settled') state = apply(state, 3, { type: 'agent_settled', aborted: true });
      if (terminal === 'error')
        state = apply(state, 3, { type: 'error', source: 'host', message: 'worker exited' });
      if (terminal === 'status')
        state = syncSessionStatuses(state, [{ id: 's', status: 'idle' }], new Set());
      if (terminal === 'history') state = applyContextRuntime(state, 's', undefined);
      expect(state.runtimeBySession.s.retry).toBeUndefined();
      expect(['failed', 'cancelled']).toContain(state.runtimeBySession.s.compaction?.phase);
      const stale = apply(state, 1, { type: 'compaction', state: operation });
      expect(stale).toBe(state);
      state = apply(state, 10, { type: 'compaction', state: operation });
      expect(['failed', 'cancelled']).toContain(state.runtimeBySession.s.compaction?.phase);
    }
  );

  it('a successful compaction invalidates old context usage, not historical totals', () => {
    let state = apply(emptyProjection(), 1, { type: 'context_runtime', snapshot });
    state = apply(state, 2, {
      type: 'usage',
      provider: 'p',
      model: 'm',
      input: 500_000,
      output: 42,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 500_042,
      cost: 1,
    });
    state = apply(state, 3, { type: 'compaction', state: operation });
    state = apply(state, 4, { type: 'compaction', state: { ...operation, phase: 'succeeded' } });
    expect(state.runtimeBySession.s.contextRuntime?.context.tokens).toBeNull();
    expect(state.runtimeBySession.s.usage.inputTokens).toBe(500_000);
    state = apply(state, 5, {
      type: 'context_runtime',
      snapshot: { ...snapshot, context: { ...snapshot.context, tokens: 12_000 } },
    });
    expect(state.runtimeBySession.s.contextRuntime?.context.tokens).toBe(12_000);
  });

  it('snapshot seq rejects old history/list data and old metadata without dropping intervening message text', () => {
    let state = apply(emptyProjection(), 5, { type: 'context_runtime', snapshot });
    expect(applyContextRuntime(state, 's', { ...snapshot, effectiveStrategy: 'off' }, 4)).toBe(
      state
    );
    state = applyContextRuntime(
      state,
      's',
      { ...snapshot, context: { ...snapshot.context, tokens: 12_000 } },
      10
    );
    const old = apply(state, 9, { type: 'compaction', state: operation });
    expect(old).toBe(state);
    state = apply(state, 8, { type: 'text_delta', delta: 'not lost' });
    expect(state.messagesBySession.s[0].text).toBe('not lost');
    expect(state.runtimeBySession.s.contextRuntime?.context.tokens).toBe(12_000);
  });

  it('a late snapshot of a closed operation cannot clear recovery or restart progress', () => {
    let state = apply(emptyProjection(), 1, { type: 'compaction', state: operation });
    state = apply(state, 2, { type: 'agent_settled', aborted: true });
    state = apply(state, 3, {
      type: 'context_runtime',
      snapshot: { ...snapshot, compaction: operation },
    });
    expect(state.runtimeBySession.s).toMatchObject({
      status: 'idle',
      recoveryRequired: true,
      compaction: { phase: 'cancelled' },
    });
    expect(state.runtimeBySession.s.contextRuntime).toBeUndefined();
  });

  it.each(['event', 'snapshot'] as const)(
    'accepts a new instance reusing an operation ID through %s after unload',
    (delivery) => {
      let state = apply(emptyProjection(), 1, { type: 'compaction', state: operation });
      state = apply(state, 2, {
        type: 'compaction',
        state: { ...operation, phase: 'cancelled', cancelSource: 'timeout' },
      });
      state = apply(state, 3, { type: 'agent_settled', aborted: true });
      state = applyContextRuntime(state, 's', undefined);
      expect(state.runtimeBySession.s.contextRuntime).toBeUndefined();
      // Unloading must not resurrect the exact operation that already ended.
      state = apply(state, 4, {
        type: 'context_runtime',
        snapshot: { ...snapshot, compaction: operation },
      });
      expect(state.runtimeBySession.s.compaction?.phase).toBe('cancelled');
      const restarted = { ...operation, startedAt: 700_000, deadlineAt: 1_300_000 };
      state = apply(
        state,
        5,
        delivery === 'event'
          ? { type: 'compaction', state: restarted }
          : {
              type: 'context_runtime',
              snapshot: { ...snapshot, compaction: restarted, recoveryRequired: true },
            }
      );
      expect(state.runtimeBySession.s).toMatchObject({
        status: 'running',
        compaction: restarted,
      });
      state = apply(state, 6, { type: 'compaction', state: { ...restarted, phase: 'succeeded' } });
      state = apply(state, 7, { type: 'compaction', state: restarted });
      expect(state.runtimeBySession.s.compaction?.phase).toBe('succeeded');
    }
  );

  it('metadata preserves the existing message projection, including unknown-context snapshots', () => {
    let state = apply(emptyProjection(), 1, {
      type: 'message_end',
      role: 'user',
      text: 'preserved',
    });
    const messages = state.messagesBySession.s;
    state = apply(state, 2, { type: 'context_runtime', snapshot });
    state = apply(state, 3, {
      type: 'context_runtime',
      snapshot: { ...snapshot, context: { ...snapshot.context, tokens: null, source: 'unknown' } },
    });
    expect(state.messagesBySession.s).toBe(messages);
    expect(state.runtimeBySession.s.contextRuntime?.context.tokens).toBeNull();
    expect(applyContextRuntime(state, 's', undefined, 1)).toBe(state);
  });

  it('a new operation may start after a terminal one, and clears the old error', () => {
    let state = apply(emptyProjection(), 1, { type: 'compaction', state: operation });
    state = apply(state, 2, { type: 'error', source: 'compaction', message: 'safe failure' });
    state = apply(state, 3, {
      type: 'compaction',
      state: { ...operation, operationId: 'op-2', startedAt: 20_000 },
    });
    expect(state.runtimeBySession.s).toMatchObject({
      status: 'running',
      error: undefined,
      compaction: { operationId: 'op-2', phase: 'running' },
    });
  });
});
