import { describe, expect, it } from 'vitest';
import { type ModelThinkingCapability, pickThinkingLevel } from './chat';

// 档位集合取自 pi 1.4.0 内置目录（getSupportedThinkingLevels 去掉 fynvra 没有的 max）
const haiku: ModelThinkingCapability = {
  thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
  defaultThinking: 'medium',
};
const opus: ModelThinkingCapability = {
  thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
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
  });

  it("falls back to the model's default when the level is not in the new model's set", () => {
    // claude-haiku-5-5 可以关掉思考，切到 claude-opus-5-5（没有 off）回落到默认档位而不是就近
    expect(pickThinkingLevel(opus, 'off')).toBe('medium');
    expect(pickThinkingLevel(gemini, 'xhigh')).toBe('medium');
  });

  it('uses the default when nothing was requested', () => {
    expect(pickThinkingLevel(opus)).toBe('medium');
  });

  it('has no level for a model without reasoning, whatever was requested', () => {
    expect(pickThinkingLevel(noReasoning, 'high')).toBeUndefined();
    expect(pickThinkingLevel(noReasoning)).toBeUndefined();
  });

  it('takes the lowest offered level when the default is missing or not offered', () => {
    expect(pickThinkingLevel({ thinkingLevels: ['high', 'xhigh'] }, 'low')).toBe('high');
    expect(
      pickThinkingLevel({ thinkingLevels: ['minimal', 'low'], defaultThinking: 'medium' }, 'off')
    ).toBe('minimal');
  });
});
