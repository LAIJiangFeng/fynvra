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

/**
 * Only backend-resolved context/window/threshold values are used, never cumulative usage.
 * An estimated window (inferred / fallback) is not shown as the model's window; `hint` explains it.
 */
export function contextLabel(
  snapshot: ContextRuntimeSnapshot | undefined,
  t: T
): { label: string; nearThreshold: boolean; hint?: string } {
  const context = snapshot?.context;
  if (!context || context.contextWindow <= 0)
    return { label: t('chat.contextUnknown'), nearThreshold: false };
  const window = formatTokens(context.contextWindow);
  const estimated = context.windowSource === 'estimated';
  const hint = estimated ? { hint: t('chat.contextWindowEstimatedHint', { window }) } : {};
  if (context.tokens === null || context.source === 'unknown')
    return {
      label: estimated
        ? t('chat.contextReestimatingUnknownWindow')
        : t('chat.contextReestimating', { window }),
      nearThreshold: false,
      ...hint,
    };
  const tokens = formatTokens(context.tokens);
  return {
    ...hint,
    label: estimated
      ? t('chat.contextUsageUnknownWindow', { tokens })
      : t('chat.contextUsage', { tokens, window }),
    nearThreshold:
      snapshot.effectiveStrategy !== 'off' &&
      context.compactionThresholdTokens !== undefined &&
      context.tokens >= context.compactionThresholdTokens,
  };
}
