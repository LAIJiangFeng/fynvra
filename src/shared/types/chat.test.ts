import { describe, expect, it } from 'vitest';
import {
  describeThinkingSource,
  isThinkingSource,
  type ModelThinkingCapability,
  nextApprovalMode,
  pickThinkingLevel,
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

describe('approval modes', () => {
  it('cycles supervised → auto-edits → full → supervised (Shift+Tab in the composer)', () => {
    expect(nextApprovalMode('supervised')).toBe('auto-edits');
    expect(nextApprovalMode('auto-edits')).toBe('full');
    expect(nextApprovalMode('full')).toBe('supervised');
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

  it('marks inferred levels (with the catalog model they came from) and fallback levels', () => {
    expect(describeThinkingSource('inferred:gpt-5.6-sol')).toEqual({
      kind: 'inferred',
      model: 'gpt-5.6-sol',
    });
    expect(describeThinkingSource('fallback')).toEqual({ kind: 'fallback' });
    expect(describeThinkingSource('catalog')).toBeUndefined();
    expect(describeThinkingSource(undefined)).toBeUndefined();
  });
});
