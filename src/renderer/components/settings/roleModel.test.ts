import type { Role, ThinkingLevel } from '@fynvra/core';
import type { ModelProviderOption } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import { normalizeRoleThinking, roleThinking, thinkingOptions, withRoleModel } from './roleModel';

// sessions:model-options 交来的形状；档位取自 pi 1.4.0 内置目录，自定义模型按 reasoning 标记
const options: ModelProviderOption[] = [
  {
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
  },
  {
    providerId: 'relay',
    name: '中转',
    api: 'openai-completions',
    models: [
      { id: 'my-chat', name: 'my-chat', thinkingLevels: [] },
      {
        id: 'my-reasoner',
        name: 'my-reasoner',
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
        defaultThinking: 'medium',
      },
    ],
  },
];

const base: Role = {
  id: 'tester',
  name: '测试工程师',
  skillIds: ['vitest'],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'supervised',
};
const withModel = (modelId: string, thinking?: ThinkingLevel): Role => ({
  ...base,
  model: {
    providerId: modelId.startsWith('claude') ? 'anthropic' : 'relay',
    modelId,
    ...(thinking ? { thinking } : {}),
  },
});

describe('roleModel', () => {
  it('没选模型：档位跟随会话模型', () => {
    expect(roleThinking(undefined, options, false)).toEqual({ kind: 'follow-session' });
    expect(roleThinking(undefined, null, true)).toEqual({ kind: 'follow-session' });
  });

  it('只列模型自己的档位；角色的档位不在集合里时显示模型的默认档位', () => {
    expect(roleThinking(withModel('claude-opus-5-5', 'high').model, options, false)).toEqual({
      kind: 'levels',
      levels: ['low', 'medium', 'high', 'xhigh'],
      value: 'high',
      defaultThinking: 'medium',
    });
    expect(roleThinking(withModel('claude-opus-5-5', 'off').model, options, false)).toMatchObject({
      kind: 'levels',
      value: 'medium',
    });
    expect(roleThinking(withModel('my-reasoner').model, options, false)).toMatchObject({
      kind: 'levels',
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
      value: 'medium',
    });
  });

  it('模型不支持推理：不显示档位控件', () => {
    expect(roleThinking(withModel('my-chat', 'high').model, options, false)).toEqual({
      kind: 'unsupported',
    });
  });

  it('读不到模型的档位：还在读、读失败、服务停用 / 没 key / 模型已删', () => {
    const model = withModel('claude-opus-5-5', 'high').model;
    expect(roleThinking(model, null, false)).toEqual({ kind: 'unknown', reason: 'loading' });
    expect(roleThinking(model, null, true)).toEqual({ kind: 'unknown', reason: 'failed' });
    expect(roleThinking({ providerId: 'off', modelId: 'x' }, options, false)).toEqual({
      kind: 'unknown',
      reason: 'unavailable',
    });
    expect(roleThinking({ providerId: 'relay', modelId: 'gone' }, options, false)).toEqual({
      kind: 'unknown',
      reason: 'unavailable',
    });
    // 重读失败但之前读到过：照旧用之前的档位
    expect(roleThinking(model, options, true)).toMatchObject({ kind: 'levels', value: 'high' });
  });

  it('换模型：档位在新模型的集合里就沿用，不在就取它的默认档位，不支持推理就去掉', () => {
    const opusHigh = withModel('claude-opus-5-5', 'high');
    expect(
      withRoleModel(opusHigh, { providerId: 'anthropic', modelId: 'claude-haiku-5-5' }, options)
    ).toEqual(withModel('claude-haiku-5-5', 'high'));
    const haikuOff = withModel('claude-haiku-5-5', 'off');
    expect(
      withRoleModel(haikuOff, { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, options)
    ).toEqual(withModel('claude-opus-5-5', 'medium'));
    expect(withRoleModel(base, { providerId: 'relay', modelId: 'my-reasoner' }, options)).toEqual(
      withModel('my-reasoner', 'medium')
    );
    expect(withRoleModel(opusHigh, { providerId: 'relay', modelId: 'my-chat' }, options)).toEqual(
      withModel('my-chat')
    );
    expect(opusHigh).toEqual(withModel('claude-opus-5-5', 'high'));
  });

  it('换到读不到档位的模型：档位原样保留，运行时 worker 还会按模型落定', () => {
    const opusHigh = withModel('claude-opus-5-5', 'high');
    expect(withRoleModel(opusHigh, { providerId: 'off', modelId: 'x' }, options)).toEqual({
      ...base,
      model: { providerId: 'off', modelId: 'x', thinking: 'high' },
    });
    expect(withRoleModel(opusHigh, { providerId: 'relay', modelId: 'my-chat' }, null)).toEqual({
      ...base,
      model: { providerId: 'relay', modelId: 'my-chat', thinking: 'high' },
    });
  });

  it('选回「跟随会话模型」：去掉模型与档位，其他字段不动', () => {
    expect(withRoleModel(withModel('claude-opus-5-5', 'high'), undefined, options)).toEqual(base);
  });

  it('保存前去掉模型不支持的档位；读不到档位时原样保存', () => {
    expect(normalizeRoleThinking(withModel('my-chat', 'high'), options)).toEqual(
      withModel('my-chat')
    );
    expect(normalizeRoleThinking(withModel('claude-opus-5-5', 'off'), options)).toEqual(
      withModel('claude-opus-5-5')
    );
    const supported = withModel('claude-opus-5-5', 'xhigh');
    expect(normalizeRoleThinking(supported, options)).toBe(supported);
    const unknown = {
      ...base,
      model: { providerId: 'off', modelId: 'x', thinking: 'off' as const },
    };
    expect(normalizeRoleThinking(unknown, options)).toBe(unknown);
    const notLoaded = withModel('my-chat', 'high');
    expect(normalizeRoleThinking(notLoaded, null)).toBe(notLoaded);
    expect(normalizeRoleThinking(base, options)).toBe(base);
  });

  it('档位选项：文字与会话里一致，模型的默认档位带「默认」', () => {
    expect(thinkingOptions(['low', 'medium', 'high', 'xhigh'], 'medium')).toEqual([
      { value: 'low', label: '低' },
      { value: 'medium', label: '中（默认）' },
      { value: 'high', label: '高' },
      { value: 'xhigh', label: '最高' },
    ]);
    expect(thinkingOptions(['off', 'minimal'])).toEqual([
      { value: 'off', label: '关闭' },
      { value: 'minimal', label: '最少' },
    ]);
  });
});
