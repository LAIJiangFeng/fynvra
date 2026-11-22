import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModelLimitsProber,
  createModelsDevCatalog,
  MODELS_DEV_URL,
  normalizeModelId,
  parseMaxOutputLimit,
  parseModelsDev,
  parseOverflowLimit,
} from './modelLimits';
import { createProviderStore } from './providerStore';
import type { FetchLike } from './testProvider';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-model-limits-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const MODELS_DEV = {
  openrouter: {
    models: {
      'openai/gpt-6-astra': { limit: { context: 400_000, output: 32_000 } },
      'acme/only-here': { limit: { context: 64_000 } },
    },
  },
  openai: { models: { 'gpt-6-astra': { limit: { context: 1_000_000, output: 128_000 } } } },
  broken: { models: { nolimit: {}, zero: { limit: { context: 0 } } } },
};

/** 按 URL 回答；没配的地址回 404 */
function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn<FetchLike>(async (url) => {
    const path = url.split('?')[0] ?? url;
    if (!(path in routes)) return { ok: false, status: 404, statusText: '', text: async () => '' };
    const body = routes[path];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify(body) };
  });
}

describe('parseModelsDev', () => {
  it('id 规范化，官方厂商的值优先，没有窗口的条目略过', () => {
    const models = parseModelsDev(MODELS_DEV);
    expect(models.get('gpt-6-astra')).toEqual({ contextWindow: 1_000_000, maxOutput: 128_000 });
    expect(models.get('only-here')).toEqual({ contextWindow: 64_000 });
    expect(models.has('nolimit')).toBe(false);
    expect(models.has('zero')).toBe(false);
  });

  it('厂商自己的条目优先，如 zhipuai 的 glm-*', () => {
    const models = parseModelsDev({
      relay: { models: { 'glm-x': { limit: { context: 1_000_000, output: 200_000 } } } },
      zhipuai: { models: { 'glm-x': { limit: { context: 200_000, output: 131_072 } } } },
      other: { models: { 'z-ai/glm-x': { limit: { context: 200_000, output: 64_000 } } } },
    });
    expect(models.get('glm-x')).toEqual({ contextWindow: 200_000, maxOutput: 131_072 });
  });

  it('没有厂商条目时最大输出取各家最小值，窗口取第一家', () => {
    const models = parseModelsDev({
      first: { models: { 'glm-x': { limit: { context: 1_000_000, output: 200_000 } } } },
      second: { models: { 'glm-x': { limit: { context: 200_000, output: 98_304 } } } },
      third: { models: { 'glm-x': { limit: { context: 128_000 } } } },
    });
    expect(models.get('glm-x')).toEqual({ contextWindow: 1_000_000, maxOutput: 98_304 });
  });

  it('不分大小写、去掉 vendor/ 前缀', () => {
    expect(normalizeModelId(' OpenAI/GPT-6-Astra ')).toBe('gpt-6-astra');
  });
});

describe('createModelsDevCatalog', () => {
  it('拉一次后写缓存，7 天内不再请求，查找不分大小写', async () => {
    const cacheFile = join(dir, 'model-metadata', 'models.dev.json');
    const fetch = fakeFetch({ [MODELS_DEV_URL]: MODELS_DEV });
    let time = 1_000;
    const catalog = createModelsDevCatalog({ fetch, cacheFile, now: () => time });
    expect(await catalog.lookup('GPT-6-astra')).toEqual({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    });
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({});
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).models['gpt-6-astra']).toBeDefined();
    time += 6 * DAY;
    await catalog.lookup('only-here');
    // 新实例从磁盘读缓存
    await createModelsDevCatalog({ fetch, cacheFile, now: () => time }).lookup('gpt-6-astra');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('缓存过期且离线时用旧缓存', async () => {
    const cacheFile = join(dir, 'models.dev.json');
    writeFileSync(
      cacheFile,
      JSON.stringify({ fetchedAt: 0, models: { 'gpt-6-astra': { contextWindow: 777_000 } } })
    );
    const fetch = fakeFetch({ [MODELS_DEV_URL]: new Error('offline') });
    const catalog = createModelsDevCatalog({ fetch, cacheFile, now: () => 30 * DAY });
    expect(await catalog.lookup('gpt-6-astra')).toEqual({ contextWindow: 777_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('没有缓存又离线时查不到，不报错', async () => {
    const fetch = fakeFetch({});
    const catalog = createModelsDevCatalog({ fetch, cacheFile: join(dir, 'x.json') });
    expect(await catalog.lookup('gpt-6-astra')).toBeUndefined();
  });
});

describe('parseOverflowLimit', () => {
  it.each([
    [
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      128_000,
    ],
    ['prompt is too long: 210345 tokens > 200000 maximum', 200_000],
    ['Your input exceeds the context window of 1,000,000 tokens', 1_000_000],
    ["This model's maximum model length is 32768 tokens", 32_768],
    ['The decoder prompt (length 40000) is longer than the maximum model length of 32768.', 32_768],
    [
      'context_length_exceeded: input 300000 + maximum output 32000 exceeds the limit of 272000',
      272_000,
    ],
    [
      '{"code":"context_length_exceeded","message":"Input exceeds the limit of 272000 tokens"}',
      272_000,
    ],
  ])('%s', (message, limit) => {
    expect(parseOverflowLimit(message)).toBe(limit);
  });

  it.each([
    'Rate limit reached: limit 30000 tokens per minute',
    '401 invalid api key',
    'context_length_exceeded',
    'context_length_exceeded: max_tokens 32000',
    'Your input exceeds the context window of this model.',
  ])('不是带上限的溢出报错：%s', (message) => {
    expect(parseOverflowLimit(message)).toBeUndefined();
  });
});

describe('createModelLimitsProber', () => {
  const RELAY = 'https://relay.example.com';

  async function setup(
    models: { id: string; name: string; contextWindow?: number; maxOutput?: number }[]
  ) {
    const store = createProviderStore({ filePath: join(dir, 'providers.json') });
    const saved = await store.upsert({
      name: 'Relay',
      api: 'openai-completions',
      baseUrl: `${RELAY}/v1`,
      enabled: true,
      models,
      apiKey: 'sk-relay-secret',
    });
    if (!saved.ok) throw new Error(saved.error);
    return { store, providerId: saved.provider.id };
  }

  it('服务端值优先于公开目录，缺的最大输出从公开目录补，保留其他字段', async () => {
    const { store, providerId } = await setup([{ id: 'gpt-6-astra', name: 'Astra' }]);
    const fetch = fakeFetch({
      [`${RELAY}/v1/models`]: { data: [{ id: 'gpt-6-astra', context_length: 2_000_000 }] },
    });
    const catalog = {
      lookup: vi.fn(async () => ({ contextWindow: 1_000_000, maxOutput: 64_000 })),
    };
    const prober = createModelLimitsProber({ store, fetch, catalog });
    expect(await prober.ensure(providerId, 'gpt-6-astra')).toBe(true);
    expect((await store.get(providerId))?.models[0]).toEqual({
      id: 'gpt-6-astra',
      name: 'Astra',
      contextWindow: 2_000_000,
      maxOutput: 64_000,
    });
  });

  it('已有窗口、缺最大输出时只补最大输出；不覆盖 learn 写回的值', async () => {
    const { store, providerId } = await setup([
      { id: 'glm-x', name: 'GLM', contextWindow: 1_000_000 },
      { id: 'glm-y', name: 'GLM Y', contextWindow: 200_000 },
    ]);
    const catalog = {
      lookup: vi.fn(async () => ({ contextWindow: 200_000, maxOutput: 131_072 })),
    };
    const prober = createModelLimitsProber({ store, fetch: fakeFetch({}), catalog });
    expect(await prober.ensure(providerId, 'glm-x')).toBe(true);
    expect((await store.get(providerId))?.models[0]).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 131_072,
    });
    expect(await prober.learnMaxOutput(providerId, 'glm-y', 98_304)).toBe(true);
    expect(await prober.ensure(providerId, 'glm-y')).toBe(false);
    expect((await store.get(providerId))?.models[1]?.maxOutput).toBe(98_304);
  });

  it('服务端不给时用公开目录；同一模型只探测一次（并发去重）', async () => {
    const { store, providerId } = await setup([{ id: 'gpt-6-astra', name: 'Astra' }]);
    const fetch = fakeFetch({ [`${RELAY}/v1/models`]: { data: [{ id: 'gpt-6-astra' }] } });
    const catalog = {
      lookup: vi.fn(async () => ({ contextWindow: 1_000_000, maxOutput: 128_000 })),
    };
    const prober = createModelLimitsProber({ store, fetch, catalog });
    const results = await Promise.all([
      prober.ensure(providerId, 'gpt-6-astra'),
      prober.ensure(providerId, 'gpt-6-astra'),
    ]);
    expect(results).toEqual([true, true]);
    await prober.ensure(providerId, 'gpt-6-astra');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(catalog.lookup).toHaveBeenCalledTimes(1);
    expect((await store.get(providerId))?.models[0]).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    });
  });

  it('窗口与最大输出都有时不探测，查不到时静默', async () => {
    const { store, providerId } = await setup([
      { id: 'known', name: 'Known', contextWindow: 200_000, maxOutput: 64_000 },
      { id: 'mystery', name: 'Mystery' },
    ]);
    const fetch = fakeFetch({});
    const log = vi.fn();
    const prober = createModelLimitsProber({
      store,
      fetch,
      catalog: { lookup: async () => undefined },
      log,
    });
    expect(await prober.ensure(providerId, 'known')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await prober.ensure(providerId, 'mystery')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-relay-secret');
  });

  it('溢出报错的上限覆盖已有值', async () => {
    const { store, providerId } = await setup([
      { id: 'gpt-6-astra', name: 'Astra', contextWindow: 1_000_000 },
    ]);
    const prober = createModelLimitsProber({
      store,
      fetch: fakeFetch({}),
      catalog: { lookup: async () => undefined },
    });
    const message = 'prompt is too long: 300000 tokens > 272000 maximum';
    expect(await prober.learn(providerId, 'gpt-6-astra', message)).toBe(true);
    expect((await store.get(providerId))?.models[0]?.contextWindow).toBe(272_000);
    expect(await prober.learn(providerId, 'gpt-6-astra', message)).toBe(false);
    expect(await prober.learn(providerId, 'gpt-6-astra', 'rate limited')).toBe(false);
  });

  it('max_tokens 超范围时写回最大输出，窗口不动，只降不升', async () => {
    const store = createProviderStore({ filePath: join(dir, 'providers.json') });
    const saved = await store.upsert({
      name: 'GLM',
      api: 'openai-completions',
      baseUrl: 'https://glm.example.com',
      enabled: true,
      models: [{ id: 'glm-x', name: 'GLM', contextWindow: 200_000, maxOutput: 200_000 }],
      apiKey: 'sk-glm-secret',
    });
    if (!saved.ok) throw new Error(saved.error);
    const providerId = saved.provider.id;
    const prober = createModelLimitsProber({
      store,
      fetch: fakeFetch({}),
      catalog: { lookup: async () => undefined },
    });
    expect(await prober.learn(providerId, 'glm-x', ZHIPU_MAX_TOKENS)).toBe(true);
    expect((await store.get(providerId))?.models[0]).toMatchObject({
      contextWindow: 200_000,
      maxOutput: 131_072,
    });
    expect(await prober.learn(providerId, 'glm-x', ZHIPU_MAX_TOKENS)).toBe(false);
    const larger = 'max_tokens must be less than or equal to 150000';
    expect(await prober.learn(providerId, 'glm-x', larger)).toBe(false);
    expect(await prober.learnMaxOutput(providerId, 'glm-x', 150_000)).toBe(false);
    expect(await prober.learnMaxOutput(providerId, 'glm-x', 0)).toBe(false);
    expect((await store.get(providerId))?.models[0]?.maxOutput).toBe(131_072);
    expect(await prober.learnMaxOutput(providerId, 'glm-x', 65_536)).toBe(true);
    expect((await store.get(providerId))?.models[0]?.maxOutput).toBe(65_536);
  });
});

const ZHIPU_MAX_TOKENS =
  '400 {"error":{"message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]","type":"invalid_request_error"},"type":"error"}';

describe('parseMaxOutputLimit', () => {
  it.each([
    [ZHIPU_MAX_TOKENS, 131_072],
    [
      'max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens for this model',
      64_000,
    ],
    [
      'max_tokens is too large: 200000. This model supports at most 128000 completion tokens, whereas you provided 200000.',
      128_000,
    ],
    ['max_tokens must be less than or equal to `8192`', 8_192],
  ])('%s', (message, limit) => {
    expect(parseMaxOutputLimit(message)).toBe(limit);
  });

  it.each([
    "This model's maximum context length is 128000 tokens.",
    'prompt is too long: 210345 tokens > 200000 maximum',
    'context_length_exceeded: max_tokens 32000',
    'Rate limit reached: limit 30000 tokens per minute',
  ])('不是最大输出报错：%s', (message) => {
    expect(parseMaxOutputLimit(message)).toBeUndefined();
  });

  it('max_tokens 报错不当作窗口', () => {
    expect(parseOverflowLimit(ZHIPU_MAX_TOKENS)).toBeUndefined();
  });
});
