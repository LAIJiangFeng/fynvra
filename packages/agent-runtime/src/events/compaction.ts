import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { CompactionState, FynvraSessionEventBody, RetryState } from '@fynvra/core';

/** One deadline per operation, never renewed by a retry. No provider text crosses this boundary. */
export function createCompactionLifecycle(timeoutMs = 600_000, maxAttempts = 1) {
  let operation = 0;
  let compaction: CompactionState | undefined;
  let retry: RetryState | undefined;
  const active = () => compaction?.phase === 'running' || compaction?.phase === 'backoff';
  const update = (patch: Partial<CompactionState>): FynvraSessionEventBody[] => {
    if (!compaction) return [];
    compaction = { ...compaction, ...patch };
    return [{ type: 'compaction', state: compaction }];
  };
  const finish = (patch: Partial<CompactionState>) => {
    const endedAt = Date.now();
    const result = update({
      ...patch,
      endedAt,
      durationMs: Math.max(0, endedAt - (compaction?.startedAt ?? endedAt)),
    });
    if (retry?.kind === 'summarization' && retry.phase !== 'finished') {
      retry = { ...retry, phase: 'finished', delayMs: 0, success: patch.phase === 'succeeded' };
      result.push({ type: 'retry', state: retry });
    }
    return result;
  };
  return {
    cancel(source: NonNullable<CompactionState['cancelSource']>): FynvraSessionEventBody[] {
      return active()
        ? finish({
            phase: 'cancelled',
            cancelSource: source,
            errorMessage:
              source === 'timeout'
                ? 'Compaction timed out. Retry compaction to resume.'
                : 'Compaction cancelled.',
          })
        : [];
    },
    push(event: AgentSessionEvent): FynvraSessionEventBody[] | undefined {
      switch (event.type) {
        case 'compaction_start': {
          const startedAt = Date.now();
          compaction = {
            operationId: `compaction-${++operation}`,
            reason: event.reason,
            phase: 'running',
            startedAt,
            deadlineAt: startedAt + timeoutMs,
            attempt: 1,
            maxAttempts,
          };
          return [{ type: 'compaction', state: compaction }];
        }
        case 'compaction_end':
          // Timeout/Stop already published the outcome. Ignore late success/failure notifications.
          if (!active()) return [];
          return finish(
            event.result && !event.aborted
              ? { phase: 'succeeded' }
              : event.aborted
                ? {
                    phase: 'cancelled',
                    cancelSource: 'sdk',
                    errorMessage: 'Compaction cancelled by the engine.',
                  }
                : {
                    phase: 'failed',
                    errorMessage:
                      'Compaction failed. Check the model service and retry compaction.',
                  }
          );
        case 'auto_retry_start':
        case 'summarization_retry_scheduled': {
          const kind = event.type === 'auto_retry_start' ? 'model' : 'summarization';
          if (kind === 'summarization' && !active()) return [];
          retry = {
            kind,
            phase: 'backoff',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
          };
          return [
            ...(kind === 'summarization'
              ? update({
                  phase: 'backoff',
                  attempt: event.attempt + 1,
                  maxAttempts: event.maxAttempts + 1,
                })
              : []),
            { type: 'retry', state: retry },
          ];
        }
        case 'summarization_retry_attempt_start':
          if (event.source !== 'compaction' || !active() || !retry) return [];
          retry = { ...retry, phase: 'running', delayMs: 0 };
          return [...update({ phase: 'running' }), { type: 'retry', state: retry }];
        case 'auto_retry_end':
          retry = {
            kind: 'model',
            phase: 'finished',
            attempt: event.attempt,
            maxAttempts: retry?.kind === 'model' ? retry.maxAttempts : event.attempt,
            delayMs: 0,
            success: event.success,
          };
          return [{ type: 'retry', state: retry }];
        case 'summarization_retry_finished':
          if (!active() || retry?.kind !== 'summarization') return [];
          // This SDK event only ends the retry indicator; compaction_end determines success.
          retry = { ...retry, phase: 'finished', delayMs: 0 };
          return [{ type: 'retry', state: retry }];
        default:
          return undefined;
      }
    },
  };
}
