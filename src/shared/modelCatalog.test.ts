import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URLS,
  findCatalogProvider,
  isProviderApi,
  MODEL_CATALOG,
  PROVIDER_APIS,
  resolveBaseUrl,
} from './modelCatalog';

describe('MODEL_CATALOG', () => {
  it('Anthropic 内置 Claude 5 家族四个模型，走 anthropic-messages', () => {
    const anthropic = findCatalogProvider('anthropic');
    expect(anthropic?.api).toBe('anthropic-messages');
    expect(anthropic?.baseUrl).toBe('https://api.anthropic.com');
    expect(anthropic?.models.map((model) => model.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
  });

  it('OpenAI / Google 带官方地址与模型；自定义 OpenAI 兼容没有默认地址和模型', () => {
    expect(findCatalogProvider('openai')).toMatchObject({
      api: 'openai-responses',
      baseUrl: DEFAULT_BASE_URLS['openai-responses'],
    });
    expect(findCatalogProvider('google')).toMatchObject({
      api: 'google-generative-ai',
      baseUrl: DEFAULT_BASE_URLS['google-generative-ai'],
    });
    expect(findCatalogProvider('openai')?.models.length).toBeGreaterThan(0);
    expect(findCatalogProvider('google')?.models.length).toBeGreaterThan(0);

    const custom = findCatalogProvider('openai-compatible');
    expect(custom).toMatchObject({ api: 'openai-completions', models: [] });
    expect(custom?.baseUrl).toBeUndefined();
  });

  it('目录 id 唯一，模型 id 在各自服务内唯一且都有展示名', () => {
    const ids = MODEL_CATALOG.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of MODEL_CATALOG) {
      expect(isProviderApi(provider.api)).toBe(true);
      const modelIds = provider.models.map((model) => model.id);
      expect(new Set(modelIds).size).toBe(modelIds.length);
      for (const model of provider.models) expect(model.name.trim()).not.toBe('');
    }
  });

  it('未知目录 id 返回 undefined', () => {
    expect(findCatalogProvider('nope')).toBeUndefined();
  });
});

describe('isProviderApi', () => {
  it('只接受 §9.6 的四种协议', () => {
    for (const api of PROVIDER_APIS) expect(isProviderApi(api)).toBe(true);
    expect(PROVIDER_APIS).toHaveLength(4);
    for (const value of ['ollama', '', null, undefined, 1, {}]) {
      expect(isProviderApi(value)).toBe(false);
    }
  });
});

describe('resolveBaseUrl', () => {
  it('留空或全是空白时用协议默认地址', () => {
    expect(resolveBaseUrl('anthropic-messages')).toBe('https://api.anthropic.com');
    expect(resolveBaseUrl('openai-completions', '   ')).toBe('https://api.openai.com/v1');
  });

  it('去掉首尾空白和末尾斜杠，自定义地址原样保留', () => {
    expect(resolveBaseUrl('openai-completions', ' https://proxy.example.com/v1/// ')).toBe(
      'https://proxy.example.com/v1'
    );
    expect(resolveBaseUrl('anthropic-messages', 'https://relay.example.com/anthropic/')).toBe(
      'https://relay.example.com/anthropic'
    );
  });

  it('Google 地址没有版本段时补 /v1beta，已有版本段不重复', () => {
    expect(resolveBaseUrl('google-generative-ai', 'https://gemini.example.com')).toBe(
      'https://gemini.example.com/v1beta'
    );
    expect(
      resolveBaseUrl('google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta/')
    ).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(resolveBaseUrl('google-generative-ai', 'https://gemini.example.com/v1')).toBe(
      'https://gemini.example.com/v1'
    );
  });
});
