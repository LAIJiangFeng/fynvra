import { findCatalogProvider } from '@shared/modelCatalog';
import type { ModelEntry, RemoteModelEntry } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import { draftFromCatalog, draftFromProvider, type ProviderDraft } from './providerForm';
import {
  canListRemoteModels,
  filterRemoteModels,
  invertVisible,
  MAX_PROVIDER_MODELS,
  markAdded,
  mergeRemoteModels,
  mergeSummary,
  pickedModels,
  remoteModelsRequest,
  selectAllVisible,
  toggleSelected,
} from './remoteModels';

const template = (id: string): ProviderDraft => {
  const entry = findCatalogProvider(id);
  if (!entry) throw new Error(`missing template ${id}`);
  return draftFromCatalog(entry);
};

const saved: ProviderDraft = draftFromProvider({
  id: 'relay',
  name: 'Relay',
  api: 'anthropic-messages',
  baseUrl: 'https://relay.example.com',
  enabled: true,
  models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
  hasApiKey: true,
  apiKeyHint: '7890',
});

const remote = (id: string, patch: Partial<RemoteModelEntry> = {}): RemoteModelEntry => ({
  id,
  name: id,
  alreadyAdded: false,
  ...patch,
});

const LIST = [
  remote('claude-haiku-4-5-20251001', { name: 'Claude Haiku 4.5' }),
  remote('claude-opus-5-5', { name: 'Claude Opus 5.5', reasoning: true, alreadyAdded: true }),
  remote('deepseek-chat'),
  remote('gpt-6-sol', { name: 'GPT-6 Sol', reasoning: true }),
];

describe('canListRemoteModels / remoteModelsRequest', () => {
  it('有地址就能点：官方协议留空用官方地址，自定义兼容服务要先填地址', () => {
    expect(canListRemoteModels(template('anthropic'))).toBe(true);
    expect(canListRemoteModels({ ...template('anthropic'), baseUrl: '' })).toBe(true);
    expect(canListRemoteModels(template('openai-compatible'))).toBe(false);
    expect(
      canListRemoteModels({ ...template('openai-compatible'), baseUrl: ' https://x.io ' })
    ).toBe(true);
  });

  it('新服务没填 key：提示先填，不发请求', () => {
    expect(remoteModelsRequest(template('anthropic'))).toEqual({
      ok: false,
      error: '先填写 API Key，再拉取模型列表',
    });
  });

  it('新服务填了 key：只传表单（协议、去空白的地址与 key）', () => {
    expect(
      remoteModelsRequest({
        ...template('openai-compatible'),
        baseUrl: ' https://relay.example.com/v1 ',
        apiKey: ' sk-new ',
      })
    ).toEqual({
      ok: true,
      input: {
        draft: {
          api: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-new',
        },
      },
    });
  });

  it('已保存的服务：传 id 用已保存的 key，表单里的协议与地址一起传；新填的 key 优先', () => {
    expect(remoteModelsRequest(saved)).toEqual({
      ok: true,
      input: {
        providerId: 'relay',
        draft: { api: 'anthropic-messages', baseUrl: 'https://relay.example.com' },
      },
    });
    expect(
      remoteModelsRequest({ ...saved, api: 'openai-responses', baseUrl: '', apiKey: 'sk-typed' })
    ).toEqual({
      ok: true,
      input: { providerId: 'relay', draft: { api: 'openai-responses', apiKey: 'sk-typed' } },
    });
  });

  it.each([
    ['勾了清除 key 又没填新的', { ...saved, clearApiKey: true }, '先填写 API Key'],
    ['已保存的服务没有 key', { ...saved, hasSavedKey: false }, '先填写 API Key'],
    ['自定义兼容服务没填地址', { ...template('openai-compatible'), apiKey: 'k' }, 'Base URL'],
    ['地址不是 http(s)', { ...saved, baseUrl: 'relay.example.com' }, 'http://'],
    ['key 含空白', { ...saved, apiKey: 'sk new' }, '空白'],
  ])('%s：给出提示', (_label, draft, hint) => {
    const request = remoteModelsRequest(draft);
    expect(request.ok).toBe(false);
    expect(request.ok ? '' : request.error).toContain(hint);
  });
});

describe('markAdded', () => {
  it('以表单当前的模型列表为准：删掉的不算已添加，手动加的算', () => {
    const current: ModelEntry[] = [{ id: 'deepseek-chat', name: 'deepseek-chat' }];
    expect(markAdded(LIST, current).map((model) => [model.id, model.alreadyAdded])).toEqual([
      ['claude-haiku-4-5-20251001', false],
      ['claude-opus-5-5', false],
      ['deepseek-chat', true],
      ['gpt-6-sol', false],
    ]);
  });
});

describe('filterRemoteModels', () => {
  it('不分大小写，按空白分词，每个词都要出现在 id 或名称里', () => {
    expect(filterRemoteModels(LIST, '  ').map((model) => model.id)).toHaveLength(4);
    expect(filterRemoteModels(LIST, 'CLAUDE').map((model) => model.id)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-5-5',
    ]);
    expect(filterRemoteModels(LIST, 'claude 4.5').map((model) => model.id)).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
    expect(filterRemoteModels(LIST, 'sol gpt').map((model) => model.id)).toEqual(['gpt-6-sol']);
    expect(filterRemoteModels(LIST, 'gemini')).toEqual([]);
  });
});

describe('选择', () => {
  const visible = filterRemoteModels(LIST, 'claude');

  it('勾选 / 取消勾选', () => {
    expect(toggleSelected([], 'a', true)).toEqual(['a']);
    expect(toggleSelected(['a'], 'a', true)).toEqual(['a']);
    expect(toggleSelected(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  it('全选只作用于当前视图里没添加过的，视图外已勾的保留', () => {
    expect(selectAllVisible(['gpt-6-sol'], visible)).toEqual([
      'gpt-6-sol',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('反选只翻转当前视图里没添加过的', () => {
    expect(invertVisible(['gpt-6-sol'], visible)).toEqual([
      'gpt-6-sol',
      'claude-haiku-4-5-20251001',
    ]);
    expect(invertVisible(['gpt-6-sol', 'claude-haiku-4-5-20251001'], visible)).toEqual([
      'gpt-6-sol',
    ]);
  });

  it('要加入的：勾选里没添加过的，按列表顺序', () => {
    expect(
      pickedModels(LIST, ['gpt-6-sol', 'claude-opus-5-5', 'deepseek-chat', 'ghost']).map(
        (model) => model.id
      )
    ).toEqual(['deepseek-chat', 'gpt-6-sol']);
  });
});

describe('mergeRemoteModels', () => {
  const current: ModelEntry[] = [
    { id: 'claude-opus-5-5', name: '我的 Opus' },
    { id: 'my-model', name: 'my-model', reasoning: true },
  ];

  it('已有的条目原样保留（名称、推理标记），新条目接在后面并带上元数据；只带 reasoning: true', () => {
    const result = mergeRemoteModels(current, [
      remote('claude-opus-5-5', { name: 'Claude Opus 5.5', reasoning: true }),
      remote('gpt-6-sol', {
        name: 'GPT-6 Sol',
        contextWindow: 272_000,
        maxOutput: 128_000,
        reasoning: true,
      }),
      remote('deepseek-chat', { reasoning: false }),
      remote('gpt-6-sol'),
    ]);
    expect(result).toEqual({
      models: [
        { id: 'claude-opus-5-5', name: '我的 Opus' },
        { id: 'my-model', name: 'my-model', reasoning: true },
        {
          id: 'gpt-6-sol',
          name: 'GPT-6 Sol',
          contextWindow: 272_000,
          maxOutput: 128_000,
          reasoning: true,
        },
        { id: 'deepseek-chat', name: 'deepseek-chat' },
      ],
      added: 2,
      existing: 2,
      overLimit: 0,
    });
    expect(result.models[0]).toBe(current[0]);
    expect(current).toHaveLength(2);
  });

  it(`每个服务最多 ${MAX_PROVIDER_MODELS} 个模型，超出的不加`, () => {
    const result = mergeRemoteModels(current, [remote('a'), remote('b'), remote('c')], 3);
    expect(result.models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'my-model', 'a']);
    expect(result).toMatchObject({ added: 1, existing: 0, overLimit: 2 });
  });

  it('合并结果的提示', () => {
    expect(mergeSummary({ models: [], added: 3, existing: 0, overLimit: 0 })).toBe(
      '已加入 3 个模型，保存后生效'
    );
    expect(mergeSummary({ models: [], added: 0, existing: 2, overLimit: 0 })).toBe(
      '没有加入新模型；2 个已在列表里'
    );
    expect(mergeSummary({ models: [], added: 1, existing: 1, overLimit: 4 })).toBe(
      `已加入 1 个模型，保存后生效；1 个已在列表里；每个服务最多 ${MAX_PROVIDER_MODELS} 个模型，4 个没有加入`
    );
  });
});
