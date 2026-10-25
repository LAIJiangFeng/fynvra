import { describe, expect, it, vi } from 'vitest';
import { configureMainLocale } from '../../../i18n';
import type { FetchLike } from '../testProvider';
import {
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  GOOGLE_RELAY_MODELS,
  HTML_PAGE,
  OPENAI_RELAY_MODELS,
} from './fixtures';
import {
  listRemoteModels,
  MAX_REMOTE_MODELS,
  type RemoteModelsTarget,
  remoteModelsRequests,
} from './listRemoteModels';

const KEY = 'sk-relay-secret-key-7890';

type Reply = { status: number; body: string } | Error;
const ok = (body: unknown): Reply => ({
  status: 200,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const http = (status: number, body = ''): Reply => ({ status, body });

/** 按调用顺序依次回答；多出来的请求直接报错，断言「不该再请求」 */
function fakeFetch(...replies: Reply[]) {
  return vi.fn<FetchLike>(async (url) => {
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${url}`);
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: '',
      text: async () => reply.body,
    };
  });
}

const anthropic = (patch: Partial<RemoteModelsTarget> = {}): RemoteModelsTarget => ({
  api: 'anthropic-messages',
  baseUrl: 'https://relay.example.com',
  apiKey: KEY,
  savedModelIds: [],
  ...patch,
});

const errorOf = (result: Awaited<ReturnType<typeof listRemoteModels>>) =>
  result.ok ? '' : result.error;

describe('remoteModelsRequests', () => {
  it('Anthropic：先 x-api-key + anthropic-version（带 limit），再回退到同一地址的 Bearer', () => {
    expect(remoteModelsRequests('anthropic-messages', undefined, 'k')).toMatchObject([
      {
        url: 'https://api.anthropic.com/v1/models?limit=1000',
        headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
        shape: 'anthropic',
      },
      {
        url: 'https://api.anthropic.com/v1/models',
        headers: { Authorization: 'Bearer k' },
        shape: 'openai',
      },
    ]);
    const [first] = remoteModelsRequests(
      'anthropic-messages',
      'https://relay.example.com/claude/',
      'k'
    );
    expect(first?.url).toBe('https://relay.example.com/claude/v1/models?limit=1000');
  });

  it('OpenAI：地址已以版本段结尾时不重复拼 /v1，只请求一次', () => {
    for (const api of ['openai-responses', 'openai-completions'] as const) {
      expect(remoteModelsRequests(api, undefined, 'k')).toEqual([
        expect.objectContaining({
          url: 'https://api.openai.com/v1/models',
          headers: { Authorization: 'Bearer k' },
        }),
      ]);
    }
    expect(
      remoteModelsRequests('openai-responses', 'https://relay.example.com/v1/', 'k').map(
        (request) => request.url
      )
    ).toEqual(['https://relay.example.com/v1/models']);
    expect(
      remoteModelsRequests('openai-completions', 'https://open.bigmodel.cn/api/paas/v4', 'k').map(
        (request) => request.url
      )
    ).toEqual(['https://open.bigmodel.cn/api/paas/v4/models']);
  });

  it('OpenAI：地址没有版本段时先 /v1/models，再回退到 pi 实际用的 <base>/models', () => {
    expect(
      remoteModelsRequests('openai-responses', 'http://relay.example.com/', 'k').map(
        (request) => request.url
      )
    ).toEqual(['http://relay.example.com/v1/models', 'http://relay.example.com/models']);
  });

  it('Google：key 放在请求头，URL 里没有 key；地址补 /v1beta', () => {
    const requests = remoteModelsRequests('google-generative-ai', undefined, KEY);
    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        headers: { 'x-goog-api-key': KEY },
        shape: 'google',
      }),
    ]);
    expect(requests[0]?.url).not.toContain(KEY);
    expect(
      remoteModelsRequests('google-generative-ai', 'https://gemini.example.com', 'k')[0]?.url
    ).toBe('https://gemini.example.com/v1beta/models?pageSize=1000');
  });
});

describe('listRemoteModels', () => {
  it('Anthropic 官方：按 id 排序，内置目录补上下文与推理，标出已添加；GET、禁止重定向', async () => {
    const fetch = fakeFetch(ok(ANTHROPIC_MODELS));
    const result = await listRemoteModels(
      anthropic({ baseUrl: undefined, savedModelIds: ['claude-opus-5-5'] }),
      { fetch }
    );
    expect(result).toEqual({
      ok: true,
      endpoint: 'https://api.anthropic.com/v1/models',
      warnings: [],
      models: [
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', alreadyAdded: false },
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          contextWindow: 1_000_000,
          maxOutput: 128_000,
          reasoning: true,
          alreadyAdded: true,
        },
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          contextWindow: 1_000_000,
          maxOutput: 128_000,
          reasoning: true,
          alreadyAdded: false,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models?limit=1000',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      })
    );
  });

  it('Anthropic 回退：404 后改用 Bearer 读 OpenAI 形态，去重，提示改用了哪种形态', async () => {
    const fetch = fakeFetch(
      http(404, '{"error":{"message":"Not Found"}}'),
      ok(OPENAI_RELAY_MODELS)
    );
    const result = await listRemoteModels(anthropic(), { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      'https://relay.example.com/v1/models',
      expect.objectContaining({ headers: { Authorization: `Bearer ${KEY}` } })
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.endpoint).toBe('https://relay.example.com/v1/models');
    expect(result.models).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        reasoning: true,
        alreadyAdded: false,
      },
      { id: 'deepseek-chat', name: 'deepseek-chat', alreadyAdded: false },
      // 内置目录按协议查：Anthropic 协议的服务里 gpt-6-sol 查不到，不带推理
      { id: 'gpt-6-sol', name: 'gpt-6-sol', alreadyAdded: false },
    ]);
    expect(result.warnings).toEqual([
      'Anthropic 形态（x-api-key）不可用（HTTP 404），已改用 OpenAI 形态（Authorization: Bearer）',
    ]);
  });

  it.each([
    ['HTTP 400', http(400, '{"error":{"message":"unknown parameter limit"}}')],
    ['HTTP 401', http(401, '{"error":{"message":"missing Authorization"}}')],
    ['HTTP 403', http(403)],
    ['HTTP 405', http(405)],
    ['200 的网页', ok(HTML_PAGE)],
    ['200 但不是列表', ok({ success: false, message: 'use /v1/models with Bearer' })],
  ])('Anthropic 形态 %s 时同样回退', async (_label, first) => {
    const fetch = fakeFetch(first, ok(OPENAI_RELAY_MODELS));
    const result = await listRemoteModels(anthropic(), { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, endpoint: 'https://relay.example.com/v1/models' });
  });

  it.each([
    [429, '额度'],
    [500, '服务端'],
  ])('Anthropic 形态 HTTP %i 不回退，直接报错', async (status, hint) => {
    const fetch = fakeFetch(http(status));
    const result = await listRemoteModels(anthropic(), { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(errorOf(result)).toContain(hint);
  });

  it.each([
    ['404 → 401', [http(404), http(401)], 'API Key 无效'],
    ['401 → 404', [http(401), http(404)], 'API Key 无效'],
    ['404 → 404', [http(404), http(404)], '接口不存在'],
    ['网页 → 网页', [ok(HTML_PAGE), ok(HTML_PAGE)], '接口返回的不是模型列表'],
    ['网页 → 404', [ok(HTML_PAGE), http(404)], '接口返回的不是模型列表'],
  ])(
    '两种形态都失败（%s）：报最能说明问题的那个，并带上请求地址',
    async (_label, replies, hint) => {
      const result = await listRemoteModels(anthropic(), { fetch: fakeFetch(...replies) });
      expect(result.ok).toBe(false);
      expect(errorOf(result)).toContain(hint);
      expect(errorOf(result)).toContain('https://relay.example.com/v1/models');
    }
  );

  it('提示按界面语言：英文不在地址后多加空格，后续动作接在「; 」之后', async () => {
    configureMainLocale({ language: () => 'en', systemLanguages: () => [] });
    try {
      const result = await listRemoteModels(
        {
          api: 'openai-responses',
          baseUrl: 'http://relay.example.com/',
          apiKey: KEY,
          savedModelIds: [],
        },
        { fetch: fakeFetch(http(404), ok(OPENAI_RELAY_MODELS)) }
      );
      if (!result.ok) throw new Error(result.error);
      expect(result.warnings).toEqual([
        'http://relay.example.com/v1/models unavailable (HTTP 404); using http://relay.example.com/models',
      ]);
      const failed = await listRemoteModels(anthropic(), {
        fetch: fakeFetch(http(404), http(404)),
      });
      expect(failed.ok).toBe(false);
      expect(errorOf(failed)).not.toMatch(/[\u4e00-\u9fff]/u);
    } finally {
      configureMainLocale(null);
    }
  });

  it('OpenAI：/v1/models 404 后改用 <base>/models', async () => {
    const fetch = fakeFetch(http(404), ok(OPENAI_RELAY_MODELS));
    const result = await listRemoteModels(
      {
        api: 'openai-responses',
        baseUrl: 'http://relay.example.com/',
        apiKey: KEY,
        savedModelIds: [],
      },
      { fetch }
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://relay.example.com/v1/models',
      'http://relay.example.com/models',
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.endpoint).toBe('http://relay.example.com/models');
    expect(result.warnings).toEqual([
      'http://relay.example.com/v1/models 不可用（HTTP 404），已改用 http://relay.example.com/models',
    ]);
    // OpenAI 协议的服务里 gpt-6-sol 在内置目录：名称、上下文与推理都补上
    expect(result.models.find((model) => model.id === 'gpt-6-sol')).toEqual({
      id: 'gpt-6-sol',
      name: 'GPT-6 Sol',
      contextWindow: 272_000,
      maxOutput: 128_000,
      reasoning: true,
      alreadyAdded: false,
    });
  });

  it('OpenAI：401 不换地址重试；地址带 /v1 时 404 直接报错', async () => {
    const unauthorized = fakeFetch(http(401, '{"error":{"message":"invalid token"}}'));
    const denied = await listRemoteModels(
      {
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com',
        apiKey: KEY,
        savedModelIds: [],
      },
      { fetch: unauthorized }
    );
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(errorOf(denied)).toContain('API Key 无效');
    expect(errorOf(denied)).toContain('invalid token');

    const missing = fakeFetch(http(404));
    const notFound = await listRemoteModels(
      {
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: KEY,
        savedModelIds: [],
      },
      { fetch: missing }
    );
    expect(missing).toHaveBeenCalledTimes(1);
    expect(errorOf(notFound)).toContain('接口不存在');
  });

  it('Google：过滤掉的模型数写进提示；服务端的 token 上限优先，推理取内置目录', async () => {
    const fetch = fakeFetch(ok(GOOGLE_MODELS));
    const result = await listRemoteModels(
      { api: 'google-generative-ai', apiKey: KEY, savedModelIds: [] },
      { fetch }
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(result.models).toEqual([
      {
        id: 'gemini-4-argon',
        name: 'Gemini 4 Argon',
        contextWindow: 1_048_576,
        maxOutput: 32_768,
        reasoning: true,
        alreadyAdded: false,
      },
      {
        id: 'gemini-flash-latest',
        name: 'Gemini Flash Latest',
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        reasoning: true,
        alreadyAdded: false,
      },
    ]);
    expect(result.warnings).toEqual([
      '已略过 2 个不支持 generateContent 的模型（如嵌入、图像模型）',
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).not.toContain(KEY);
    expect(init?.headers).toEqual({ 'x-goog-api-key': KEY });
  });

  it('服务端说还有下一页时提示列表不完整', async () => {
    const result = await listRemoteModels(
      { api: 'google-generative-ai', apiKey: KEY, savedModelIds: [] },
      { fetch: fakeFetch(ok(GOOGLE_RELAY_MODELS)) }
    );
    expect(result.ok && result.warnings).toEqual([
      '服务端还有更多模型没有返回，这里只列出了第一页',
    ]);
  });

  it('id 为空、含空白或过长的条目跳过并计数；重复的只留一个', async () => {
    const result = await listRemoteModels(anthropic(), {
      fetch: fakeFetch(
        ok({
          data: [
            { id: 'claude-opus-5-5' },
            { id: '  ' },
            { id: 'my model' },
            { id: 'x'.repeat(201) },
            { id: ' claude-opus-5-5 ' },
            { name: 'no id' },
          ],
        })
      ),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.models.map((model) => model.id)).toEqual(['claude-opus-5-5']);
    expect(result.warnings).toEqual(['4 个条目没有有效的模型 id，已跳过']);
  });

  it('按 id 自然排序（数字按大小）', async () => {
    const result = await listRemoteModels(anthropic(), {
      fetch: fakeFetch(ok({ data: [{ id: 'm-10' }, { id: 'm-9' }, { id: 'b' }, { id: 'A-1' }] })),
    });
    expect(result.ok && result.models.map((model) => model.id)).toEqual([
      'A-1',
      'b',
      'm-9',
      'm-10',
    ]);
  });

  it(`超过 ${MAX_REMOTE_MODELS} 个只列出前 ${MAX_REMOTE_MODELS} 个并提示`, async () => {
    const data = Array.from({ length: MAX_REMOTE_MODELS + 1 }, (_, i) => ({
      id: `m-${String(i).padStart(4, '0')}`,
    }));
    const result = await listRemoteModels(anthropic(), { fetch: fakeFetch(ok({ data })) });
    if (!result.ok) throw new Error(result.error);
    expect(result.models).toHaveLength(MAX_REMOTE_MODELS);
    expect(result.warnings).toEqual([`模型太多，只列出前 ${MAX_REMOTE_MODELS} 个`]);
  });

  it('连不上：报主机名与原因（含底层 cause）', async () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
    });
    const result = await listRemoteModels(anthropic(), { fetch: fakeFetch(error) });
    expect(errorOf(result)).toBe(
      '无法连接 relay.example.com：fetch failed（connect ECONNREFUSED 127.0.0.1:443）'
    );
  });

  it('超时后中止请求并返回超时错误，不再回退', async () => {
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = await listRemoteModels(anthropic(), { fetch, timeoutMs: 10 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(errorOf(result)).toBe('请求超时（1 秒）：relay.example.com');
  });

  it('返回值里没有 key：错误回显、连接错误、模型 id / 名称、地址里的 key 都被去掉', async () => {
    const echoed = await listRemoteModels(anthropic(), {
      fetch: fakeFetch(
        http(401, JSON.stringify({ error: { message: `invalid x-api-key ${KEY}` } })),
        http(401, JSON.stringify({ error: { message: `invalid token ${KEY}` } }))
      ),
    });
    expect(errorOf(echoed)).toContain('API Key 无效');
    expect(errorOf(echoed)).toContain('invalid x-api-key ***');

    const network = await listRemoteModels(anthropic(), {
      fetch: fakeFetch(new Error(`proxy refused ${KEY}`)),
    });
    expect(errorOf(network)).toContain('proxy refused ***');

    const listed = await listRemoteModels(
      anthropic({ baseUrl: `https://relay.example.com/${KEY}` }),
      {
        fetch: fakeFetch(
          ok({
            data: [
              { id: 'claude-opus-5-5', display_name: `Opus for ${KEY}` },
              { id: `key-${KEY}`, display_name: 'Leaked' },
            ],
            has_more: true,
          })
        ),
      }
    );
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.models.map((model) => [model.id, model.name])).toEqual([
      ['claude-opus-5-5', 'Claude Opus 5.5'],
    ]);
    expect(listed.endpoint).toBe('https://relay.example.com/***/v1/models');

    for (const result of [echoed, network, listed]) {
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});
