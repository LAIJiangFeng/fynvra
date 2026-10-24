import { findCatalogProvider } from '@shared/modelCatalog';
import type { ModelProviderView } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import {
  addModel,
  draftFromCatalog,
  draftFromProvider,
  draftToUpsertInput,
  type ProviderDraft,
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
});
