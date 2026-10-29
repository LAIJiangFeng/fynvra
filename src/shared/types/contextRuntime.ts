import type { CompactionState, ContextRuntimeSnapshot, RetryState } from '@fynvra/core';
import { asRecord, isNonEmptyString } from '../guards';
import { isCompactionStrategy, isCompactionTimeoutMs } from './settings';

const count = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const optionalCount = (x: unknown) => x === undefined || count(x);
const member = <T extends string>(x: unknown, values: readonly T[]): x is T =>
  typeof x === 'string' && (values as readonly string[]).includes(x);

export function parseCompactionState(raw: unknown): CompactionState | null {
  const r = asRecord(raw);
  if (
    !r ||
    !isNonEmptyString(r.operationId) ||
    r.operationId.length > 100 ||
    !member(r.reason, ['manual', 'threshold', 'overflow']) ||
    !member(r.phase, ['running', 'backoff', 'succeeded', 'failed', 'cancelled']) ||
    !count(r.startedAt) ||
    !count(r.deadlineAt) ||
    r.deadlineAt < r.startedAt ||
    !count(r.attempt) ||
    !count(r.maxAttempts) ||
    r.attempt < 1 ||
    r.maxAttempts < r.attempt ||
    !optionalCount(r.endedAt) ||
    !optionalCount(r.durationMs) ||
    (r.cancelSource !== undefined &&
      !member(r.cancelSource, ['user', 'timeout', 'shutdown', 'exception', 'sdk'])) ||
    (r.errorMessage !== undefined &&
      (typeof r.errorMessage !== 'string' || r.errorMessage.length > 300))
  )
    return null;
  return {
    operationId: r.operationId,
    reason: r.reason,
    phase: r.phase,
    startedAt: r.startedAt,
    deadlineAt: r.deadlineAt,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt as number } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs as number } : {}),
    ...(r.cancelSource !== undefined
      ? { cancelSource: r.cancelSource as CompactionState['cancelSource'] }
      : {}),
    ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage as string } : {}),
  };
}
export function parseRetryState(raw: unknown): RetryState | null {
  const r = asRecord(raw);
  if (
    !r ||
    !member(r.kind, ['model', 'summarization']) ||
    !member(r.phase, ['backoff', 'running', 'finished']) ||
    !count(r.attempt) ||
    !count(r.maxAttempts) ||
    r.attempt > r.maxAttempts ||
    !count(r.delayMs) ||
    (r.success !== undefined && typeof r.success !== 'boolean')
  )
    return null;
  return {
    kind: r.kind,
    phase: r.phase,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    delayMs: r.delayMs,
    ...(r.success !== undefined ? { success: r.success as boolean } : {}),
  };
}
export function parseContextRuntime(raw: unknown): ContextRuntimeSnapshot | null {
  const r = asRecord(raw);
  const c = asRecord(r?.context);
  if (
    !r ||
    !c ||
    !isCompactionStrategy(r.configuredStrategy) ||
    !isCompactionStrategy(r.effectiveStrategy) ||
    !isCompactionTimeoutMs(r.compactionTimeoutMs) ||
    !count(c.contextWindow) ||
    !(c.tokens === null || count(c.tokens)) ||
    !member(c.source, ['sdk', 'unknown']) ||
    (c.source === 'unknown' && c.tokens !== null) ||
    !optionalCount(c.compactionThresholdTokens) ||
    typeof r.recoveryRequired !== 'boolean' ||
    !count(r.pendingPromptCount)
  )
    return null;
  const compaction = r.compaction === undefined ? undefined : parseCompactionState(r.compaction);
  const retry = r.retry === undefined ? undefined : parseRetryState(r.retry);
  if (compaction === null || retry === null) return null;
  return {
    configuredStrategy: r.configuredStrategy,
    effectiveStrategy: r.effectiveStrategy,
    compactionTimeoutMs: r.compactionTimeoutMs,
    context: {
      tokens: c.tokens,
      contextWindow: c.contextWindow,
      source: c.source,
      ...(c.compactionThresholdTokens !== undefined
        ? { compactionThresholdTokens: c.compactionThresholdTokens as number }
        : {}),
    },
    recoveryRequired: r.recoveryRequired,
    pendingPromptCount: r.pendingPromptCount,
    ...(compaction ? { compaction } : {}),
    ...(retry ? { retry } : {}),
  };
}
