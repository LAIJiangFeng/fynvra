import { describe, expect, it } from 'vitest';
import type { StoredProvider } from '../providerStore';
import { parseListRemoteModelsInput, remoteModelsTarget } from './input';

const KEY = 'sk-saved-secret-1234';
const stored: StoredProvider = {
  id: 'relay',
  name: 'Relay',
  api: 'anthropic-messages',
  baseUrl: 'https://relay.example.com',
  enabled: true,
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true },
    { id: 'my-model', name: 'my-model' },
  ],
  apiKey: KEY,
};

const errorOf = (result: { ok: true } | { ok: false; error: string }) =>
  result.ok ? '' : result.error;

describe('parseListRemoteModelsInput', () => {
  it('只传已保存服务的 id', () => {
    expect(parseListRemoteModelsInput({ providerId: 'relay' })).toEqual({
      ok: true,
      input: { providerId: 'relay' },
    });
  });

  it('只传表单：地址与 key 去首尾空白；空地址、null 视为没填', () => {
    expect(
      parseListRemoteModelsInput({
        draft: {
          api: 'openai-completions',
          baseUrl: '  https://relay.example.com/v1  ',
          apiKey: ' sk-new-key ',
        },
      })
    ).toEqual({
      ok: true,
      input: {
        draft: {
          api: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-new-key',
        },
      },
    });
    expect(
      parseListRemoteModelsInput({ draft: { api: 'anthropic-messages', baseUrl: '   ' } })
    ).toEqual({ ok: true, input: { draft: { api: 'anthropic-messages' } } });
    expect(
      parseListRemoteModelsInput({
        draft: { api: 'google-generative-ai', baseUrl: null, apiKey: null },
      })
    ).toEqual({ ok: true, input: { draft: { api: 'google-generative-ai' } } });
  });

  it('两个都传时原样保留', () => {
    expect(
      parseListRemoteModelsInput({
        providerId: 'relay',
        draft: { api: 'openai-responses', baseUrl: 'http://relay.example.com' },
      })
    ).toEqual({
      ok: true,
      input: {
        providerId: 'relay',
        draft: { api: 'openai-responses', baseUrl: 'http://relay.example.com' },
      },
    });
  });

  it.each([
    ['null', null, '需要一个对象'],
    ['字符串', 'relay', '需要一个对象'],
    ['数组', [{ providerId: 'relay' }], '需要一个对象'],
    ['未知字段', { providerId: 'relay', apiKey: KEY }, '未知字段 apiKey'],
    ['两个都没有', {}, '需要模型服务 id'],
    ['id 带路径', { providerId: '../providers' }, '无效的模型服务 id'],
    ['id 不是字符串', { providerId: 7 }, '无效的模型服务 id'],
    ['表单不是对象', { providerId: 'relay', draft: 'anthropic-messages' }, '需要一个对象'],
    ['表单未知字段', { draft: { api: 'anthropic-messages', name: 'x' } }, '未知字段 name'],
    ['不支持的协议', { draft: { api: 'ollama' } }, '不支持的 API 协议'],
    ['缺协议', { draft: { baseUrl: 'https://relay.example.com' } }, '不支持的 API 协议'],
    ['地址不是字符串', { draft: { api: 'anthropic-messages', baseUrl: 42 } }, '必须是字符串'],
    ['地址不是 http(s)', { draft: { api: 'anthropic-messages', baseUrl: 'ftp://x' } }, 'http(s)'],
    [
      '地址过长',
      { draft: { api: 'anthropic-messages', baseUrl: `https://${'a'.repeat(2048)}.com` } },
      'http(s)',
    ],
    ['key 不是字符串', { draft: { api: 'anthropic-messages', apiKey: 42 } }, '必须是字符串'],
    ['key 为空白', { draft: { api: 'anthropic-messages', apiKey: '   ' } }, '不能为空'],
    ['key 含空白', { draft: { api: 'anthropic-messages', apiKey: 'sk new' } }, '不能包含空白'],
  ])('拒绝非法入参：%s', (_label, raw, message) => {
    const result = parseListRemoteModelsInput(raw);
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toContain(message);
  });

  it('错误信息不回显 key', () => {
    const result = parseListRemoteModelsInput({
      draft: { api: 'anthropic-messages', apiKey: `${KEY} trailing` },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('remoteModelsTarget', () => {
  it('只传 id：用已保存的协议、地址与 key，带上已保存的模型 id', () => {
    expect(remoteModelsTarget({ providerId: 'relay' }, stored)).toEqual({
      ok: true,
      target: {
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com',
        apiKey: KEY,
        savedModelIds: ['claude-opus-5-5', 'my-model'],
      },
    });
  });

  it('只传表单：用表单的协议、地址与 key；没有 key 时报错', () => {
    expect(
      remoteModelsTarget(
        {
          draft: { api: 'openai-completions', baseUrl: 'https://x.example.com', apiKey: 'sk-new' },
        },
        undefined
      )
    ).toEqual({
      ok: true,
      target: {
        api: 'openai-completions',
        baseUrl: 'https://x.example.com',
        apiKey: 'sk-new',
        savedModelIds: [],
      },
    });
    expect(
      errorOf(remoteModelsTarget({ draft: { api: 'openai-completions' } }, undefined))
    ).toContain('API Key');
  });

  it('两个都传：协议与地址以表单为准（表单没写地址就是官方地址），key 以表单优先、没带用已保存的', () => {
    expect(
      remoteModelsTarget(
        {
          providerId: 'relay',
          draft: { api: 'openai-responses', baseUrl: 'http://y.example.com' },
        },
        stored
      )
    ).toMatchObject({
      ok: true,
      target: { api: 'openai-responses', baseUrl: 'http://y.example.com', apiKey: KEY },
    });

    const official = remoteModelsTarget(
      { providerId: 'relay', draft: { api: 'anthropic-messages', apiKey: 'sk-typed' } },
      stored
    );
    expect(official).toEqual({
      ok: true,
      target: {
        api: 'anthropic-messages',
        apiKey: 'sk-typed',
        savedModelIds: ['claude-opus-5-5', 'my-model'],
      },
    });
  });

  it('id 对应的服务不存在；已保存的服务没有 key、表单也没带', () => {
    expect(remoteModelsTarget({ providerId: 'ghost' }, undefined)).toEqual({
      ok: false,
      error: '模型服务不存在',
    });
    const { apiKey: _omit, ...withoutKey } = stored;
    expect(
      errorOf(
        remoteModelsTarget(
          { providerId: 'relay', draft: { api: 'anthropic-messages' } },
          withoutKey
        )
      )
    ).toContain('API Key');
  });
});
