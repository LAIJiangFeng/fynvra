import { describe, expect, it, vi } from 'vitest';
import type { StoredProvider } from './providerStore';
import { buildModelsRequest, type FetchLike, testProvider } from './testProvider';

const provider: StoredProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  enabled: true,
  models: [],
  apiKey: 'sk-ant-secret-1234',
};

const respond = (status: number, body: string, statusText = ''): ReturnType<FetchLike> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  });

/** 每次调用推进 120ms 的假时钟 */
const clock = () => {
  let t = 1000;
  return () => {
    t += 120;
    return t;
  };
};

describe('buildModelsRequest', () => {
  it('Anthropic：<base>/v1/models，x-api-key + anthropic-version', () => {
    expect(buildModelsRequest('anthropic-messages', undefined, 'k')).toEqual({
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    });
    expect(
      buildModelsRequest('anthropic-messages', 'https://relay.example.com/claude/', 'k').url
    ).toBe('https://relay.example.com/claude/v1/models');
  });

  it('OpenAI 两种协议与自定义兼容服务：<base>/models + Bearer', () => {
    for (const api of ['openai-responses', 'openai-completions'] as const) {
      expect(buildModelsRequest(api, undefined, 'k')).toEqual({
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: 'Bearer k' },
      });
    }
    expect(buildModelsRequest('openai-completions', 'https://api.deepseek.com/', 'k').url).toBe(
      'https://api.deepseek.com/models'
    );
  });

  it('Google：key 放在请求头而不是 URL 里，地址补 /v1beta', () => {
    expect(buildModelsRequest('google-generative-ai', undefined, 'k')).toEqual({
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: { 'x-goog-api-key': 'k' },
    });
    expect(buildModelsRequest('google-generative-ai', 'https://gemini.example.com', 'k').url).toBe(
      'https://gemini.example.com/v1beta/models'
    );
  });
});

describe('testProvider', () => {
  it('200 + 模型列表：成功，带耗时与模型数；GET、禁止重定向', async () => {
    const fetch = vi.fn<FetchLike>(() => respond(200, JSON.stringify({ data: [{}, {}, {}] })));
    expect(await testProvider(provider, { fetch, now: clock() })).toEqual({
      ok: true,
      latencyMs: 120,
      modelCount: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
  });

  it('Google 的 { models: [...] } 也能数出模型数；认不出的 JSON 对象只报成功', async () => {
    const google: StoredProvider = { ...provider, api: 'google-generative-ai' };
    const counted = await testProvider(google, {
      fetch: () => respond(200, JSON.stringify({ models: [{}] })),
    });
    expect(counted).toMatchObject({ ok: true, modelCount: 1 });
    const plain = await testProvider(provider, { fetch: () => respond(200, '{"object":"list"}') });
    expect(plain).toMatchObject({ ok: true });
    expect(plain).not.toHaveProperty('modelCount');
  });

  it('没有 key 时不发请求', async () => {
    const fetch = vi.fn<FetchLike>();
    const { apiKey: _omit, ...noKey } = provider;
    expect(await testProvider(noKey, { fetch })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('401：可读错误带状态码与服务端说明，回显的 key 被打码', async () => {
    const body = JSON.stringify({
      error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret-1234' },
    });
    const result = await testProvider(provider, { fetch: () => respond(401, body) });
    expect(result.ok).toBe(false);
    const error = result.ok ? '' : result.error;
    expect(error).toContain('API Key 无效');
    expect(error).toContain('HTTP 401');
    expect(error).toContain('invalid x-api-key');
    expect(error).not.toContain('sk-ant-secret-1234');
  });

  it.each([
    [404, 'Base URL'],
    [429, '额度'],
    [503, '服务端'],
  ])('HTTP %i 给出对应提示', async (status, hint) => {
    const result = await testProvider(provider, { fetch: () => respond(status, 'oops') });
    expect(result.ok ? '' : result.error).toContain(hint);
  });

  it('HTML 错误页不回显到错误信息里', async () => {
    const result = await testProvider(provider, {
      fetch: () => respond(502, '<html><body>Bad gateway</body></html>'),
    });
    expect(result.ok ? '' : result.error).toBe('服务端错误，请稍后重试（HTTP 502）');
  });

  it('200 但不是 JSON（多半是网页）：提示检查 Base URL', async () => {
    const result = await testProvider(provider, {
      fetch: () => respond(200, '<!doctype html><title>Login</title>'),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toContain('Base URL');
  });

  it('连不上：报出主机名，错误信息里的 key 被打码', async () => {
    const result = await testProvider(provider, {
      fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND sk-ant-secret-1234')),
    });
    const error = result.ok ? '' : result.error;
    expect(error).toContain('api.anthropic.com');
    expect(error).not.toContain('sk-ant-secret-1234');
  });

  it('超时后中止请求并返回超时错误', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await testProvider(provider, { fetch, timeoutMs: 10 });
    expect(result.ok ? '' : result.error).toContain('超时');
  });
});
