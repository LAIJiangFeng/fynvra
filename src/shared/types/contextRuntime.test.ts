import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentWorkerEvent } from './agent';
import { parseCompactionState, parseContextRuntime, parseRetryState } from './contextRuntime';
import {
  compactionTimeoutMsOf,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  parsePreferences,
  parsePreferencesPatch,
} from './settings';

const state = {
  operationId: 'compaction-1',
  reason: 'threshold',
  phase: 'backoff',
  startedAt: 1000,
  deadlineAt: 31000,
  attempt: 2,
  maxAttempts: 4,
};
const snapshot = {
  configuredStrategy: 'magic-context',
  effectiveStrategy: 'native',
  compactionTimeoutMs: 30000,
  context: {
    tokens: null,
    contextWindow: 272000,
    source: 'unknown',
    compactionThresholdTokens: 255616,
  },
  compaction: state,
  recoveryRequired: true,
  pendingPromptCount: 1,
};

describe('context runtime protocol', () => {
  it('validates timeout settings on read, patch and helper boundaries', () => {
    for (const value of [undefined, null, 0, 29999, 1800001, 30000.5, Infinity, '600000']) {
      expect(compactionTimeoutMsOf({ compactionTimeoutMs: value as number })).toBe(
        DEFAULT_COMPACTION_TIMEOUT_MS
      );
      expect(parsePreferences({ compactionTimeoutMs: value })).not.toHaveProperty(
        'compactionTimeoutMs'
      );
      expect(parsePreferencesPatch({ compactionTimeoutMs: value })).toBeNull();
    }
    for (const value of [30000, 600000, 1800000]) {
      expect(parsePreferencesPatch({ compactionTimeoutMs: value })).toEqual({
        compactionTimeoutMs: value,
      });
      expect(compactionTimeoutMsOf({ compactionTimeoutMs: value })).toBe(value);
    }
  });
  it('preserves unknown context and actual effective strategy across the unknown boundary', () => {
    expect(parseContextRuntime(snapshot)).toEqual(snapshot);
    expect(
      parseContextRuntime({ ...snapshot, context: { ...snapshot.context, tokens: 256000 } })
    ).toBeNull();
    expect(parseContextRuntime({ ...snapshot, compactionTimeoutMs: 1 })).toBeNull();
    expect(parseCompactionState({ ...state, durationMs: -1 })).toBeNull();
    expect(parseCompactionState({ ...state, attempt: 5 })).toBeNull();
    expect(parseCompactionState({ ...state, cancelSource: 'unknown' })).toBeNull();
    expect(parseCompactionState({ ...state, errorMessage: 'x'.repeat(301) })).toBeNull();
    expect(
      parseRetryState({
        kind: 'summarization',
        phase: 'backoff',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
      })
    ).not.toBeNull();
    const identity = { sessionId: 's1', generation: 2 };
    const event = {
      type: 'session-event',
      identity,
      seq: 3,
      event: { type: 'context_runtime', snapshot, seq: 3 },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, seq: 2 })).toBeNull();
    expect(parseAgentCommand({ type: 'retry-compaction', identity })).toEqual({
      type: 'retry-compaction',
      identity,
    });
  });
});
