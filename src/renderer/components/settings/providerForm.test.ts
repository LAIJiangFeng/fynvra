import { findCatalogProvider } from '@shared/modelCatalog';
import type { ModelProviderView } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import {
  addModel,
  type DescribedModels,
  draftFromCatalog,
  draftFromProvider,
  draftToUpsertInput,
  type ProviderDraft,
  reasoningControl,
  setModelReasoning,
} from './providerForm';

const anthropicTemplate = findCatalogProvider('anthropic');
const customTemplate = findCatalogProvider('openai-compatible');

const saved: ModelProviderView = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
  hasApiKey: true,
  apiKeyHint: 'abcd',
};

describe('providerForm', () => {
  it('从目录模板起草：带上协议、官方地址与模型副本', () => {
    if (!anthropicTemplate) throw new Error('missing template');
    const draft = draftFromCatalog(anthropicTemplate);
    expect(draft).toMatchObject({
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      enabled: true,
      requiresBaseUrl: false,
    });
    expect(draft.models).toHaveLength(4);
    draft.models.pop();
    expect(anthropicTemplate.models).toHaveLength(4);
  });

  it('新建：key 有值才提交，Base URL 留空则不提交', () => {
    if (!anthropicTemplate) throw new Error('missing template');
    const draft: ProviderDraft = {
      ...draftFromCatalog(anthropicTemplate),
      baseUrl: '',
      apiKey: '  sk-ant-new  ',
    };
    const result = draftToUpsertInput(draft);
    expect(result).toMatchObject({
      ok: true,
      input: { name: 'Anthropic', api: 'anthropic-messages', enabled: true, apiKey: 'sk-ant-new' },
    });
    expect(result.ok && 'baseUrl' in result.input).toBe(false);
    expect(result.ok && 'id' in result.input).toBe(false);
  });

  it('编辑：key 留空表示不改（不提交 apiKey），勾选清除则提交 null', () => {
    const draft = draftFromProvider(saved);
    expect(draft).toMatchObject({ id: 'anthropic', apiKey: '', savedKeyHint: 'abcd' });
    const kept = draftToUpsertInput(draft);
    expect(kept).toMatchObject({ ok: true, input: { id: 'anthropic' } });
    expect(kept.ok && 'apiKey' in kept.input).toBe(false);
    expect(draftToUpsertInput({ ...draft, clearApiKey: true })).toMatchObject({
      ok: true,
      input: { apiKey: null },
    });
  });

  it('校验：名称必填；自定义兼容服务必须填 Base URL；地址必须是 http(s)；key 不能含空白', () => {
    if (!customTemplate) throw new Error('missing template');
    const custom = { ...draftFromCatalog(customTemplate), name: 'DeepSeek' };
    expect(draftToUpsertInput({ ...custom, name: '  ' })).toMatchObject({ ok: false });
    expect(draftToUpsertInput(custom)).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...custom, baseUrl: 'api.deepseek.com' })).toMatchObject({
      ok: false,
    });
    expect(
      draftToUpsertInput({ ...custom, baseUrl: 'https://api.deepseek.com', apiKey: 'sk a' })
    ).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...custom, baseUrl: 'https://api.deepseek.com' })).toMatchObject({
      ok: true,
      input: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
    });
  });

  it('addModel：去空白、拒绝空 id 与重复 id，名称缺省用 id', () => {
    const models = [{ id: 'a', name: 'A' }];
    expect(addModel(models, ' deepseek-chat ')).toEqual({
      ok: true,
      models: [
        { id: 'a', name: 'A' },
        { id: 'deepseek-chat', name: 'deepseek-chat' },
      ],
    });
    expect(addModel(models, ' ')).toMatchObject({ ok: false });
    expect(addModel(models, 'a')).toMatchObject({ ok: false });
    expect(addModel(models, 'has space')).toMatchObject({ ok: false });
  });

  it('setModelReasoning：打开写 reasoning: true，关闭去掉字段，其他模型不动；保存时随模型提交', () => {
    const models = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', reasoning: true },
    ];
    const on = setModelReasoning(models, 'a', true);
    expect(on).toEqual([
      { id: 'a', name: 'A', reasoning: true },
      { id: 'b', name: 'B', reasoning: true },
    ]);
    expect(setModelReasoning(on, 'b', false)).toEqual([
      { id: 'a', name: 'A', reasoning: true },
      { id: 'b', name: 'B' },
    ]);
    expect(models[0]).toEqual({ id: 'a', name: 'A' });
    if (!customTemplate) throw new Error('missing template');
    const draft = {
      ...draftFromCatalog(customTemplate),
      name: 'Relay',
      baseUrl: 'https://relay.example.com/v1',
      models: on,
    };
    expect(draftToUpsertInput(draft)).toMatchObject({ ok: true, input: { models: on } });
  });
});

describe('reasoningControl', () => {
  // providers store 的 modelOptions：sessions:model-options 的回答，连同发请求时的服务列表（算档位用的标记）
  const codex: ModelProviderView = {
    id: 'codex',
    name: 'Codex',
    api: 'openai-responses',
    enabled: true,
    hasApiKey: true,
    models: [
      { id: 'gpt-6-astra', name: 'gpt-6-astra' },
      { id: 'gpt-4.1', name: 'gpt-4.1', reasoning: true },
      { id: 'my-model', name: 'my-model' },
      { id: 'my-reasoner', name: 'my-reasoner', reasoning: true },
    ],
  };
  const anthropic: ModelProviderView = {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    enabled: true,
    hasApiKey: true,
    models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
  };
  const described: DescribedModels = {
    providers: [codex, anthropic],
    options: [
      {
        providerId: 'codex',
        name: 'Codex',
        api: 'openai-responses',
        models: [
          {
            id: 'gpt-6-astra',
            name: 'gpt-6-astra',
            thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
            defaultThinking: 'medium',
          },
          { id: 'gpt-4.1', name: 'gpt-4.1', thinkingLevels: [] },
          { id: 'my-model', name: 'my-model', thinkingLevels: [] },
          {
            id: 'my-reasoner',
            name: 'my-reasoner',
            thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
            defaultThinking: 'medium',
          },
        ],
      },
      {
        providerId: 'anthropic',
        name: 'Anthropic',
        api: 'anthropic-messages',
        models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', thinkingLevels: [] }],
      },
    ],
  };

  it('设置页模板目录里同协议同 id 的模型：由内置目录决定', () => {
    expect(reasoningControl('anthropic-messages', 'claude-opus-5-5', null, undefined)).toEqual({
      kind: 'catalog',
      reasoning: true,
    });
    expect(reasoningControl('openai-responses', 'gpt-5.5', null, undefined)).toEqual({
      kind: 'catalog',
      reasoning: true,
    });
    // 协议不同就不是同一个目录条目
    expect(reasoningControl('openai-completions', 'gpt-5.5', null, undefined)).toEqual({
      kind: 'switch',
    });
    expect(reasoningControl('openai-completions', 'deepseek-chat', null, undefined)).toEqual({
      kind: 'switch',
    });
  });

  it('已保存的模型：model-options 的档位与算档位时的标记对不上，只能是内置目录在决定', () => {
    // 没标推理却有档位：Codex 导入的 gpt-6-astra 在 pi 目录里
    expect(reasoningControl('openai-responses', 'gpt-6-astra', described, 'codex')).toEqual({
      kind: 'catalog',
      reasoning: true,
    });
    // 标了推理却没有档位：目录里的非推理模型
    expect(reasoningControl('openai-responses', 'gpt-4.1', described, 'codex')).toEqual({
      kind: 'catalog',
      reasoning: false,
    });
    // 对得上：目录外的模型，给开关
    expect(reasoningControl('openai-responses', 'my-model', described, 'codex')).toEqual({
      kind: 'switch',
    });
    expect(reasoningControl('openai-responses', 'my-reasoner', described, 'codex')).toEqual({
      kind: 'switch',
    });
  });

  it('模板目录里的模型以 model-options 的档位为准', () => {
    expect(
      reasoningControl('anthropic-messages', 'claude-opus-5-5', described, 'anthropic')
    ).toEqual({ kind: 'catalog', reasoning: false });
  });

  it('没有可比的档位：表单改了协议、模型是新加的、服务不在 model-options 里、还没读到', () => {
    expect(reasoningControl('openai-completions', 'gpt-6-astra', described, 'codex')).toEqual({
      kind: 'switch',
    });
    expect(reasoningControl('openai-responses', 'new-model', described, 'codex')).toEqual({
      kind: 'switch',
    });
    expect(
      reasoningControl('openai-responses', 'gpt-6-astra', { ...described, options: [] }, 'codex')
    ).toEqual({ kind: 'switch' });
    expect(reasoningControl('openai-responses', 'gpt-6-astra', described, undefined)).toEqual({
      kind: 'switch',
    });
    expect(reasoningControl('openai-responses', 'gpt-6-astra', null, 'codex')).toEqual({
      kind: 'switch',
    });
  });
});
