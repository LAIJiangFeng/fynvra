import { THINKING_LEVELS } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  isThinkingSource,
  type ModelThinkingCapability,
  pickThinkingLevel,
  THINKING_LEVEL_HINTS,
  THINKING_LEVEL_LABELS,
  thinkingSourceNote,
} from './chat';

// 档位集合取自 pi 1.4.0 内置目录（getSupportedThinkingLevels，含 max）
const haiku: ModelThinkingCapability = {
  thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
const opus: ModelThinkingCapability = {
  thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
const fable: ModelThinkingCapability = {
  thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
// gpt-5.5 的 max 映射为 null
const gpt55: ModelThinkingCapability = {
  thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
  defaultThinking: 'medium',
};
const gemini: ModelThinkingCapability = {
  thinkingLevels: ['low', 'medium', 'high'],
  defaultThinking: 'medium',
};
const noReasoning: ModelThinkingCapability = { thinkingLevels: [] };

describe('pickThinkingLevel', () => {
  it('keeps a requested level the model offers', () => {
    expect(pickThinkingLevel(haiku, 'off')).toBe('off');
    expect(pickThinkingLevel(opus, 'xhigh')).toBe('xhigh');
    expect(pickThinkingLevel(fable, 'max')).toBe('max');
    expect(pickThinkingLevel(opus, 'max')).toBe('max');
  });

  it("falls back to the model's default when the level is not in the new model's set", () => {
    // claude-haiku-5-5 可以关掉思考，切到 claude-opus-5-5（没有 off）回落到默认档位而不是就近
    expect(pickThinkingLevel(opus, 'off')).toBe('medium');
    expect(pickThinkingLevel(gemini, 'xhigh')).toBe('medium');
    // fable 开着 max 切到 gpt-5.5（没有 max）：回落到默认档位，不是就近的 xhigh
    expect(pickThinkingLevel(gpt55, 'max')).toBe('medium');
    expect(pickThinkingLevel(gemini, 'max')).toBe('medium');
    expect(pickThinkingLevel(fable, 'off')).toBe('medium');
  });

  it('uses the default when nothing was requested', () => {
    expect(pickThinkingLevel(opus)).toBe('medium');
  });

  it('has no level for a model without reasoning, whatever was requested', () => {
    expect(pickThinkingLevel(noReasoning, 'high')).toBeUndefined();
    expect(pickThinkingLevel(noReasoning, 'max')).toBeUndefined();
    expect(pickThinkingLevel(noReasoning)).toBeUndefined();
  });

  it('takes the middle offered level when the default is missing or not offered', () => {
    // 偶数个时取偏低的那一档
    expect(pickThinkingLevel({ thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })).toBe(
      'high'
    );
    expect(pickThinkingLevel({ thinkingLevels: ['low', 'medium', 'high', 'xhigh'] }, 'off')).toBe(
      'medium'
    );
    expect(pickThinkingLevel({ thinkingLevels: ['high', 'xhigh'] }, 'low')).toBe('high');
    expect(pickThinkingLevel({ thinkingLevels: ['max'] })).toBe('max');
    expect(
      pickThinkingLevel({ thinkingLevels: ['minimal', 'low'], defaultThinking: 'medium' }, 'off')
    ).toBe('minimal');
  });
});

describe('thinking level labels', () => {
  it('shows the official level names, with the Chinese meaning of off', () => {
    expect(THINKING_LEVELS.map((level) => THINKING_LEVEL_LABELS[level])).toEqual([
      'off · 关闭',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('explains every level in Chinese for the hover text', () => {
    for (const level of THINKING_LEVELS) {
      expect(THINKING_LEVEL_HINTS[level]).toMatch(/[一-鿿]/);
    }
    expect(new Set(THINKING_LEVELS.map((level) => THINKING_LEVEL_HINTS[level])).size).toBe(
      THINKING_LEVELS.length
    );
  });
});

describe('thinking source', () => {
  it('accepts catalog, fallback and inferred:<catalog model id>', () => {
    for (const source of ['catalog', 'fallback', 'inferred:claude-opus-4-8', 'inferred:gpt-5.6']) {
      expect(isThinkingSource(source)).toBe(true);
    }
    for (const source of ['inferred:', 'inferred: gpt', 'Catalog', 'guess', '', 1, null, {}]) {
      expect(isThinkingSource(source)).toBe(false);
    }
  });

  it('notes beside the levels which catalog model they were inferred from', () => {
    expect(thinkingSourceNote('inferred:gpt-5.6-sol')).toBe('按 gpt-5.6-sol 推断');
    expect(thinkingSourceNote('fallback')).toBe('目录里没有这个模型，按协议兜底');
    expect(thinkingSourceNote('catalog')).toBeUndefined();
    expect(thinkingSourceNote(undefined)).toBeUndefined();
  });
});
