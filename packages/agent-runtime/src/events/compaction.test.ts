import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventNormalizer } from './normalize';

afterEach(() => vi.useRealTimers());
describe('compaction lifecycle normalization', () => {
  it('keeps one operation/deadline through retry and reports the terminal cancellation exactly once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const normalizer = createEventNormalizer(30000);
    const started = normalizer.push({ type: 'compaction_start', reason: 'threshold' });
    const operationId =
      started[0]?.type === 'compaction' ? started[0].state.operationId : undefined;
    expect(operationId).toMatch(/^compaction-[0-9a-f-]{36}$/);
    expect(started).toMatchObject([
      {
        type: 'compaction',
        state: {
          operationId,
          phase: 'running',
          startedAt: 1000,
          deadlineAt: 31000,
        },
      },
    ]);
    vi.setSystemTime(9000);
    const retry = normalizer.push({
      type: 'summarization_retry_scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'secret provider body',
    });
    expect(retry).toMatchObject([
      {
        type: 'compaction',
        state: {
          operationId,
          phase: 'backoff',
          startedAt: 1000,
          deadlineAt: 31000,
          attempt: 2,
          maxAttempts: 4,
        },
      },
      {
        type: 'retry',
        state: {
          kind: 'summarization',
          phase: 'backoff',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
        },
      },
    ]);
    expect(JSON.stringify(retry)).not.toContain('secret');
    normalizer.push({
      type: 'summarization_retry_attempt_start',
      source: 'compaction',
      reason: 'threshold',
    });
    normalizer.push({ type: 'summarization_retry_finished' });
    vi.setSystemTime(31000);
    expect(normalizer.cancelCompaction('timeout')).toMatchObject([
      {
        type: 'compaction',
        state: { phase: 'cancelled', cancelSource: 'timeout', durationMs: 30000 },
      },
    ]);
    expect(normalizer.cancelCompaction('user')).toEqual([]);
    expect(
      normalizer.push({
        type: 'compaction_end',
        reason: 'threshold',
        result: { summary: 'late', firstKeptEntryId: 'x', tokensBefore: 2000 },
        aborted: false,
        willRetry: false,
      })
    ).toEqual([]);
  });
  it('gives replacement instances distinct operation identities even in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const first = createEventNormalizer();
    const old = first.push({ type: 'compaction_start', reason: 'manual' })[0];
    first.cancelCompaction('shutdown');
    const replacement = createEventNormalizer().push({
      type: 'compaction_start',
      reason: 'manual',
    })[0];
    if (old?.type !== 'compaction' || replacement?.type !== 'compaction')
      throw new Error('missing lifecycle');
    expect(replacement.state.startedAt).toBe(old.state.startedAt);
    expect(replacement.state.operationId).not.toBe(old.state.operationId);
  });
  it('reports model retries independently and never converts successful retry completion to a failure', () => {
    const normalizer = createEventNormalizer();
    expect(
      normalizer.push({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '503',
      })
    ).toMatchObject([{ type: 'retry', state: { kind: 'model', phase: 'backoff' } }]);
    expect(normalizer.push({ type: 'auto_retry_end', attempt: 1, success: true })).toMatchObject([
      { type: 'retry', state: { kind: 'model', phase: 'finished', success: true } },
    ]);
    expect(normalizer.push({ type: 'agent_settled', aborted: false }).map((e) => e.type)).toEqual([
      'agent_settled',
    ]);
  });
});
