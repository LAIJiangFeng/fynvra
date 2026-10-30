import type { CompactionState, ContextRuntimeSnapshot } from '@fynvra/core';
import type { CompactionStrategy } from '@shared/types/settings';
import type { T } from '../../i18n';
import { formatTokens } from './format';

export function compactionFailure(state: CompactionState | undefined, t: T): string | undefined {
  if (
    (state?.phase === 'cancelled' || state?.phase === 'failed') &&
    state.cancelSource === 'timeout'
  )
    return t('chat.compactionTimeout');
  if (state?.phase === 'cancelled') {
    if (state.cancelSource === 'user') return t('chat.compactionCancelled');
    return t('chat.compactionInterrupted');
  }
  if (state?.phase === 'failed') return state.errorMessage || t('chat.compactionFailed');
  return undefined;
}

export function strategyLabel(strategy: CompactionStrategy | undefined, t: T): string {
  if (strategy === 'native') return t('chat.engineNative');
  if (strategy === 'magic-context') return 'Magic Context';
  if (strategy === 'off') return t('chat.engineOff');
  return t('chat.engineUnknown');
}

export function strategyNotice(
  snapshot: ContextRuntimeSnapshot | undefined,
  selected: CompactionStrategy,
  t: T
): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.configuredStrategy !== selected) return t('chat.strategyPending');
  if (snapshot.configuredStrategy === 'magic-context' && snapshot.recoveryRequired)
    return t('chat.magicContextFallback');
  return undefined;
}

/** Only backend-resolved context/window/threshold values are used, never cumulative usage. */
export function contextLabel(
  snapshot: ContextRuntimeSnapshot | undefined,
  t: T
): { label: string; nearThreshold: boolean } {
  const context = snapshot?.context;
  if (!context || context.contextWindow <= 0)
    return { label: t('chat.contextUnknown'), nearThreshold: false };
  if (context.tokens === null || context.source === 'unknown')
    return {
      label: t('chat.contextReestimating', { window: formatTokens(context.contextWindow) }),
      nearThreshold: false,
    };
  return {
    label: t('chat.contextUsage', {
      tokens: formatTokens(context.tokens),
      window: formatTokens(context.contextWindow),
    }),
    nearThreshold:
      snapshot.effectiveStrategy !== 'off' &&
      context.compactionThresholdTokens !== undefined &&
      context.tokens >= context.compactionThresholdTokens,
  };
}
