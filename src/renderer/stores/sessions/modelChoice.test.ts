import { type ModelProviderOption, THINKING_LEVEL_HINTS } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import {
  chooseModel,
  defaultModelChoice,
  describedThinking,
  effectiveThinking,
  filterModelOptions,
  findModel,
  modelKey,
  modelLabel,
  thinkingChoices,
} from './modelChoice';

// 档位取自 pi 1.4.0 内置目录（worker 经 sessions:model-options 交来的形状，含 max 与来源）
const anthropic: ModelProviderOption = {
  providerId: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  models: [
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinking: 'medium',
      source: 'catalog',
    },
    {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinking: 'medium',
      source: 'catalog',
    },
  ],
};
const codex: ModelProviderOption = {
  providerId: 'codex',
  name: 'Codex',
  api: 'openai-responses',
  models: [
    {
      id: 'gpt-5.5',
      name: 'gpt-5.5',
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
      source: 'catalog',
    },
    {
      id: 'gpt-5.6',
      name: 'gpt-5.6',
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinking: 'medium',
      source: 'inferred:gpt-5.6-terra',
    },
    {
      id: 'my-reasoner',
      name: 'my-reasoner',
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
      source: 'fallback',
    },
  ],
};
const local: ModelProviderOption = {
  providerId: 'local',
  name: 'Local vLLM',
  api: 'openai-completions',
  models: [{ id: 'plain-chat', name: 'Plain Chat', thinkingLevels: [] }],
};
const providers = [anthropic, local];

describe('defaultModelChoice', () => {
  const role = (providerId: string, modelId: string, thinking?: 'off' | 'high') => ({
    providerId,
    modelId,
    ...(thinking ? { thinking } : {}),
  });

  it("prefers the role's model, with the role's level settled for that model", () => {
    expect(
      defaultModelChoice({
        providers,
        roleModel: role('anthropic', 'claude-haiku-5-5', 'off'),
        lastUsed: { providerId: 'local', modelId: 'plain-chat' },
      })
    ).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-5-5', thinking: 'off' });
    // opus 5.5 没有 off：回落到它的默认档位
    expect(
      defaultModelChoice({ providers, roleModel: role('anthropic', 'claude-opus-5-5', 'off') })
    ).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'medium' });
  });

  it('then the model last used in the workspace, then the first model in the list', () => {
    const lastUsed = {
      providerId: 'anthropic',
      modelId: 'claude-haiku-5-5',
      thinking: 'high' as const,
    };
    expect(defaultModelChoice({ providers, lastUsed })).toEqual(lastUsed);
    expect(defaultModelChoice({ providers })).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      thinking: 'medium',
    });
  });

  it('skips references to services or models that are no longer offered', () => {
    expect(
      defaultModelChoice({
        providers,
        roleModel: role('disabled', 'x'),
        lastUsed: { providerId: 'anthropic', modelId: 'claude-removed' },
      })
    ).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'medium' });
    expect(defaultModelChoice({ providers: [] })).toBeUndefined();
  });

  it('carries no thinking level for a model without reasoning', () => {
    expect(
      defaultModelChoice({ providers, roleModel: role('local', 'plain-chat', 'high') })
    ).toEqual({ providerId: 'local', modelId: 'plain-chat' });
  });
});

describe('chooseModel', () => {
  const opus = findModel(providers, { providerId: 'anthropic', modelId: 'claude-opus-5-5' });
  const haiku = findModel(providers, { providerId: 'anthropic', modelId: 'claude-haiku-5-5' });
  const plain = findModel(providers, { providerId: 'local', modelId: 'plain-chat' });

  it("keeps the current level when the new model offers it, else falls back to the new model's default", () => {
    if (!opus || !haiku || !plain) throw new Error('fixture models are missing');
    expect(chooseModel(opus, 'xhigh')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      thinking: 'xhigh',
    });
    // haiku 关着思考（off）切到 opus：opus 没有 off，回落到 medium
    expect(chooseModel(opus, 'off').thinking).toBe('medium');
    expect(chooseModel(haiku, 'off').thinking).toBe('off');
    expect(chooseModel(plain, 'high')).toEqual({ providerId: 'local', modelId: 'plain-chat' });
  });

  it("keeps max on a model that offers it, else falls back to the new model's default", () => {
    const gpt55 = findModel([codex], { providerId: 'codex', modelId: 'gpt-5.5' });
    const gpt56 = findModel([codex], { providerId: 'codex', modelId: 'gpt-5.6' });
    if (!opus || !gpt55 || !gpt56) throw new Error('fixture models are missing');
    expect(chooseModel(opus, 'max').thinking).toBe('max');
    expect(chooseModel(gpt56, 'max').thinking).toBe('max');
    // gpt-5.5 没有 max：回落到它的默认档位，不是就近的 xhigh
    expect(chooseModel(gpt55, 'max').thinking).toBe('medium');
  });
});

describe('thinkingChoices', () => {
  it('renders exactly the levels it is given, in order, with official names and Chinese hints', () => {
    expect(thinkingChoices(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).toEqual([
      { value: 'minimal', label: 'minimal', hint: THINKING_LEVEL_HINTS.minimal },
      { value: 'low', label: 'low', hint: THINKING_LEVEL_HINTS.low },
      { value: 'medium', label: 'medium', hint: THINKING_LEVEL_HINTS.medium },
      { value: 'high', label: 'high', hint: THINKING_LEVEL_HINTS.high },
      { value: 'xhigh', label: 'xhigh', hint: THINKING_LEVEL_HINTS.xhigh },
      { value: 'max', label: 'max', hint: THINKING_LEVEL_HINTS.max },
    ]);
    expect(thinkingChoices(['off', 'low']).map((choice) => choice.label)).toEqual([
      'off · 关闭',
      'low',
    ]);
    expect(thinkingChoices([])).toEqual([]);
  });
});

describe('effectiveThinking', () => {
  it("uses the session's level, else the role's, settled for the model like the worker does", () => {
    const opus = anthropic.models[0];
    if (!opus) throw new Error('fixture model is missing');
    expect(effectiveThinking(opus, 'high', 'low')).toBe('high');
    expect(effectiveThinking(opus, undefined, 'low')).toBe('low');
    expect(effectiveThinking(opus, undefined, 'off')).toBe('medium');
    expect(effectiveThinking(opus)).toBe('medium');
    expect(effectiveThinking(local.models[0], 'high')).toBeUndefined();
  });
});

describe('filterModelOptions', () => {
  it('keeps a whole service whose name matches, else the matching models, ignoring case', () => {
    expect(filterModelOptions(providers, '  ')).toEqual(providers);
    expect(filterModelOptions(providers, 'anthropic')).toEqual([anthropic]);
    expect(filterModelOptions(providers, 'HAIKU')).toEqual([
      { ...anthropic, models: [anthropic.models[1]] },
    ]);
    expect(filterModelOptions(providers, 'plain-c')).toEqual([local]);
    expect(filterModelOptions(providers, 'gpt')).toEqual([]);
  });
});

describe('modelLabel / modelKey', () => {
  it('names the service, the model and the level, falling back to ids', () => {
    expect(
      modelLabel(providers, { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, 'xhigh')
    ).toEqual({ provider: 'Anthropic', model: 'Claude Opus 5.5', thinking: 'xhigh' });
    // 胶囊与状态栏用官方等级名本身（off 也一样短），中文说明放在悬停提示里
    expect(
      modelLabel(providers, { providerId: 'anthropic', modelId: 'claude-haiku-5-5' }, 'off')
    ).toEqual({ provider: 'Anthropic', model: 'Claude Haiku 5.5', thinking: 'off' });
    expect(
      modelLabel(providers, { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, 'max')
        ?.thinking
    ).toBe('max');
    expect(modelLabel(providers, { providerId: 'gone', modelId: 'gpt-5.5' })).toEqual({
      provider: 'gone',
      model: 'gpt-5.5',
    });
    expect(modelLabel(providers, undefined)).toBeUndefined();
  });

  it('keys a model by service and model id', () => {
    expect(modelKey({ providerId: 'local', modelId: 'qwen3:32b' })).toBe('local:qwen3:32b');
  });
});

describe('describedThinking', () => {
  const options = [anthropic, codex, local];
  const described = (api: ModelProviderOption['api'], modelId: string, providerId?: string) =>
    describedThinking(options, { api, modelId, ...(providerId ? { providerId } : {}) });

  it("uses the service's own saved entry, whatever its source", () => {
    expect(described('openai-responses', 'my-reasoner', 'codex')?.source).toBe('fallback');
  });

  it('borrows catalog and inferred levels from another service of the same api', () => {
    expect(described('openai-responses', 'gpt-5.6', 'new')?.source).toBe('inferred:gpt-5.6-terra');
    expect(described('anthropic-messages', 'claude-opus-5-5')?.thinkingLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('does not borrow fallback levels, levels of another api or levels without a source', () => {
    // 兜底的档位取决于那个服务里的推理标记
    expect(described('openai-responses', 'my-reasoner')).toBeUndefined();
    expect(described('openai-completions', 'gpt-5.5')).toBeUndefined();
    // 表单里改了协议：已保存的条目是按旧协议算的
    expect(described('openai-completions', 'gpt-5.5', 'codex')).toBeUndefined();
    expect(described('openai-completions', 'plain-chat')).toBeUndefined();
    expect(described('openai-responses', 'unknown')).toBeUndefined();
  });
});
