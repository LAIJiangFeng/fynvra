import type { CompactionState, ContextRuntimeSnapshot } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import { translatorOf } from '../../i18n';
import { compactionFailure, contextLabel, strategyLabel, strategyNotice } from './contextDisplay';

const runtime: ContextRuntimeSnapshot = {
  configuredStrategy: 'magic-context',
  effectiveStrategy: 'magic-context',
  compactionTimeoutMs: 600_000,
  context: {
    tokens: 41_000,
    contextWindow: 128_000,
    source: 'sdk',
  },
  recoveryRequired: true,
  pendingPromptCount: 0,
};
const failed: CompactionState = {
  operationId: 'op',
  reason: 'threshold',
  phase: 'cancelled',
  startedAt: 10,
  deadlineAt: 20,
  attempt: 2,
  maxAttempts: 3,
  cancelSource: 'timeout',
};

describe('runtime strategy and current-context copy', () => {
  it.each(['zh-CN', 'en'] as const)(
    'distinguishes Magic recovery from a not-yet-applied strategy (%s)',
    (locale) => {
      const t = translatorOf(locale);
      expect(strategyLabel(undefined, t)).toBe(t('chat.engineUnknown'));
      expect(strategyLabel(runtime.effectiveStrategy, t)).toBe('Magic Context');
      expect(strategyNotice(runtime, 'magic-context', t)).toBe(t('chat.magicContextFallback'));
      expect(strategyNotice(runtime, 'off', t)).toBe(t('chat.strategyPending'));
      expect(strategyNotice(undefined, 'off', t)).toBeUndefined();
      expect(
        strategyNotice({ ...runtime, recoveryRequired: false }, 'magic-context', t)
      ).toBeUndefined();
    }
  );

  it('shows resolved context independently of cumulative tokens, and only uses the backend threshold', () => {
    const t = translatorOf('en');
    expect(contextLabel(runtime, t)).toEqual({
      label: 'Current context ≈ 41k / 128k',
      nearThreshold: false,
    });
    const large = {
      ...runtime,
      context: { tokens: 120_000, contextWindow: 128_000, source: 'sdk' as const },
    };
    expect(contextLabel(large, t).nearThreshold).toBe(false); // no guessed percentage / 272k limit
    expect(
      contextLabel(
        {
          ...large,
          configuredStrategy: 'native',
          effectiveStrategy: 'native',
          context: { ...large.context, compactionThresholdTokens: 112_000 },
        },
        t
      ).nearThreshold
    ).toBe(true);
    expect(
      contextLabel(
        { ...runtime, effectiveStrategy: 'off', context: { ...runtime.context, tokens: 120_000 } },
        t
      ).nearThreshold
    ).toBe(false);
  });

  it('unknown post-compaction usage never shows an obsolete count or a threshold warning', () => {
    const t = translatorOf('zh-CN');
    expect(
      contextLabel(
        { ...runtime, context: { ...runtime.context, tokens: null, source: 'unknown' } },
        t
      )
    ).toEqual({
      label: '当前上下文：等待重新估算 / 128k',
      nearThreshold: false,
    });
    expect(contextLabel(undefined, t).label).toBe(t('chat.contextUnknown'));
  });

  it('timeout and cancellation use explicit safe status copy; a failure displays only its safe message', () => {
    const t = translatorOf('zh-CN');
    expect(compactionFailure({ ...failed, errorMessage: 'ignored provider payload' }, t)).toBe(
      '历史压缩超时，原会话已保留，可重试'
    );
    expect(compactionFailure({ ...failed, cancelSource: 'user' }, t)).toBe(
      t('chat.compactionCancelled')
    );
    expect(
      compactionFailure(
        {
          ...failed,
          phase: 'failed',
          cancelSource: 'exception',
          errorMessage: 'safe bounded message',
        },
        t
      )
    ).toBe('safe bounded message');
    expect(compactionFailure({ ...failed, phase: 'failed' }, t)).toBe(t('chat.compactionTimeout'));
    expect(compactionFailure({ ...failed, phase: 'succeeded' }, t)).toBeUndefined();
  });
});
