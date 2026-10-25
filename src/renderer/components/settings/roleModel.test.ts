import type { Role, ThinkingLevel } from '@fynvra/core';
import type { ModelProviderOption } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import { translatorOf } from '../../i18n';
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
      {
        id: 'claude-opus-4-8[1m]',
        name: 'Opus 4.8 1M',
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultThinking: 'medium',
        source: 'inferred:claude-opus-4-8',
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
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      value: 'high',
      defaultThinking: 'medium',
      source: 'catalog',
    });
    expect(roleThinking(withModel('claude-opus-5-5', 'max').model, options, false)).toMatchObject({
      kind: 'levels',
      value: 'max',
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

  it('按目录推断出来的档位带上来源，编辑器据此提示「按 <id> 推断」', () => {
    expect(roleThinking(withModel('claude-opus-4-8[1m]', 'max').model, options, false)).toEqual({
      kind: 'levels',
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      value: 'max',
      defaultThinking: 'medium',
      source: 'inferred:claude-opus-4-8',
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

  it('档位选项：官方等级名（与会话里一致），模型的默认档位带「默认」，悬停是中文说明', () => {
    const zh = translatorOf('zh-CN');
    expect(thinkingOptions(['low', 'medium', 'high', 'xhigh', 'max'], 'medium', zh)).toEqual([
      { value: 'low', label: 'low', hint: '少量思考' },
      { value: 'medium', label: 'medium（默认）', hint: '适中' },
      { value: 'high', label: 'high', hint: '深入思考' },
      { value: 'xhigh', label: 'xhigh', hint: '更深入思考' },
      { value: 'max', label: 'max', hint: '最大思考' },
    ]);
    expect(
      thinkingOptions(['off', 'minimal'], undefined, zh).map((option) => option.label)
    ).toEqual(['off · 关闭', 'minimal']);
  });

  it('档位选项按界面语言：英文的 off 不附说明，默认档位写 (default)', () => {
    const en = translatorOf('en');
    expect(thinkingOptions(['off', 'medium'], 'medium', en)).toEqual([
      { value: 'off', label: 'off', hint: 'No thinking' },
      { value: 'medium', label: 'medium (default)', hint: 'Balanced' },
    ]);
  });
});
