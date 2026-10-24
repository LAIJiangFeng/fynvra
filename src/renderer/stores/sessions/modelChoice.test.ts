import type { ModelProviderOption } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import {
  chooseModel,
  defaultModelChoice,
  effectiveThinking,
  filterModelOptions,
  findModel,
  modelKey,
  modelLabel,
} from './modelChoice';

// 档位取自 pi 1.4.0 内置目录（worker 经 sessions:model-options 交来的形状）
const anthropic: ModelProviderOption = {
  providerId: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  models: [
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
    },
    {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultThinking: 'medium',
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
    ).toEqual({ provider: 'Anthropic', model: 'Claude Opus 5.5', thinking: '最高' });
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
