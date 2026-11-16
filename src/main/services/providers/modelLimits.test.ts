import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModelLimitsProber,
  createModelsDevCatalog,
  MODELS_DEV_URL,
  normalizeModelId,
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
    'Your input exceeds the context window of this model.',
  ])('不是带上限的溢出报错：%s', (message) => {
    expect(parseOverflowLimit(message)).toBeUndefined();
  });
});

describe('createModelLimitsProber', () => {
  const RELAY = 'https://relay.example.com';

  async function setup(models: { id: string; name: string; contextWindow?: number }[]) {
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

  it('服务端值优先于公开目录，只补缺失的字段并保留其他字段', async () => {
    const { store, providerId } = await setup([{ id: 'gpt-6-astra', name: 'Astra' }]);
    const fetch = fakeFetch({
      [`${RELAY}/v1/models`]: { data: [{ id: 'gpt-6-astra', context_length: 2_000_000 }] },
    });
    const catalog = { lookup: vi.fn(async () => ({ contextWindow: 1_000_000 })) };
    const prober = createModelLimitsProber({ store, fetch, catalog });
    expect(await prober.ensure(providerId, 'gpt-6-astra')).toBe(true);
    expect((await store.get(providerId))?.models[0]).toEqual({
      id: 'gpt-6-astra',
      name: 'Astra',
      contextWindow: 2_000_000,
    });
    expect(catalog.lookup).not.toHaveBeenCalled();
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

  it('已有窗口时不探测，查不到时静默', async () => {
    const { store, providerId } = await setup([
      { id: 'known', name: 'Known', contextWindow: 200_000 },
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
});
