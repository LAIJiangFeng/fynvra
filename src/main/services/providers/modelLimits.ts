import { readFile } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import type { ModelEntry } from '@shared/types/llm';
import { writeJsonAtomic } from './jsonRegistry';
import type { ProviderStore, StoredProvider } from './providerStore';
import { listRemoteModels } from './remoteModels/listRemoteModels';
import { type FetchLike, parseJson } from './testProvider';

// 模型真实上下文窗口的自动探测（Main）。来源按可信度：溢出报错里端点自己报的上限 > 服务端列表的元数据 >
// 公开目录 models.dev。结果写进 providers.json 的模型条目，worker 经 ResolvedModelSpec 优先使用。

export type ModelLimits = Pick<ModelEntry, 'contextWindow' | 'maxOutput'>;

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 拉取失败后这段时间内不再重试（离线时不让每个模型都等一次超时） */
const MODELS_DEV_RETRY_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
/** 同一 id 在多家都有时，以官方厂商的值为准 */
const OFFICIAL_PROVIDERS = new Set(['openai', 'anthropic', 'google']);
/** 比这还小的「上限」不是窗口（报错里的其他数字） */
const MIN_WINDOW = 1024;

type LogFn = (level: 'info' | 'warn', message: string) => void;

/** 不分大小写、去掉 `vendor/` 前缀：`OpenAI/GPT-5` 与 `gpt-5` 是同一个模型 */
export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^.*\//, '');
}

/** models.dev 的 `{ [provider]: { models: { [id]: { limit: { context, output } } } } }` → 规范化 id → 上限 */
export function parseModelsDev(body: unknown): Map<string, ModelLimits> {
  const result = new Map<string, ModelLimits>();
  const official = new Set<string>();
  for (const [providerKey, rawProvider] of Object.entries(asRecord(body) ?? {})) {
    const isOfficial = OFFICIAL_PROVIDERS.has(providerKey);
    for (const [modelKey, rawModel] of Object.entries(
      asRecord(asRecord(rawProvider)?.models) ?? {}
    )) {
      const limit = asRecord(asRecord(rawModel)?.limit);
      if (!limit || !isPositiveInt(limit.context)) continue;
      const id = normalizeModelId(modelKey);
      if (official.has(id) || (result.has(id) && !isOfficial)) continue;
      result.set(id, {
        contextWindow: limit.context,
        ...(isPositiveInt(limit.output) ? { maxOutput: limit.output } : {}),
      });
      if (isOfficial) official.add(id);
    }
  }
  return result;
}

export interface ModelsDevCatalog {
  lookup(modelId: string): Promise<ModelLimits | undefined>;
}

interface CachedCatalog {
  fetchedAt: number;
  models: Map<string, ModelLimits>;
}

/**
 * models.dev 公开目录：匿名 GET（不带 key 与用户数据），压缩成 id → 上限后缓存到 cacheFile，7 天内不再请求；
 * 过期后重新拉取，失败（离线、超时）时继续用旧缓存。从不 reject。
 */
export function createModelsDevCatalog(options: {
  fetch: FetchLike;
  cacheFile: string;
  now?: () => number;
  timeoutMs?: number;
}): ModelsDevCatalog {
  const now = options.now ?? Date.now;
  let loading: Promise<CachedCatalog | null> | null = null;
  let cache: CachedCatalog | null = null;
  let refreshing: Promise<void> | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;

  async function refresh(): Promise<void> {
    lastAttempt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
    try {
      const response = await options.fetch(MODELS_DEV_URL, {
        method: 'GET',
        headers: {},
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) return;
      const models = parseModelsDev(parseJson(await response.text()));
      if (models.size === 0) return;
      cache = { fetchedAt: now(), models };
      // 写缓存失败不影响本次使用
      await writeJsonAtomic(options.cacheFile, {
        fetchedAt: cache.fetchedAt,
        models: Object.fromEntries(models),
      }).catch(() => undefined);
    } catch {
      // 离线或超时：沿用旧缓存
    } finally {
      clearTimeout(timer);
    }
  }

  async function current(): Promise<Map<string, ModelLimits> | undefined> {
    loading ??= readCache(options.cacheFile).then((read) => (cache ??= read));
    await loading;
    const stale = !cache || now() - cache.fetchedAt >= MODELS_DEV_TTL_MS;
    if (stale && !refreshing && now() - lastAttempt >= MODELS_DEV_RETRY_MS) {
      refreshing = refresh().finally(() => {
        refreshing = null;
      });
    }
    if (stale && refreshing) await refreshing;
    return cache?.models;
  }

  return {
    async lookup(modelId) {
      return (await current())?.get(normalizeModelId(modelId));
    },
  };
}

async function readCache(cacheFile: string): Promise<CachedCatalog | null> {
  try {
    const record = asRecord(JSON.parse(await readFile(cacheFile, 'utf8')));
    if (!record || typeof record.fetchedAt !== 'number') return null;
    const models = new Map<string, ModelLimits>();
    for (const [id, raw] of Object.entries(asRecord(record.models) ?? {})) {
      const limits = asRecord(raw);
      if (!limits || !isPositiveInt(limits.contextWindow)) continue;
      models.set(id, {
        contextWindow: limits.contextWindow,
        ...(isPositiveInt(limits.maxOutput) ? { maxOutput: limits.maxOutput } : {}),
      });
    }
    return { fetchedAt: record.fetchedAt, models };
  } catch {
    return null;
  }
}

/** 服务端在溢出报错里报的上限（各家措辞），按顺序匹配第一个 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  // OpenAI / vLLM：This model's maximum context length is 128000 tokens
  /maximum context length is (\d[\d,]*)/i,
  // Anthropic：prompt is too long: 210000 tokens > 200000 maximum
  /prompt is too long:\s*[\d,]+\s*tokens?\s*>\s*(\d[\d,]*)/i,
  /exceeds? the context window (?:size )?of (\d[\d,]*)/i,
  // vLLM：maximum model length is 32768 / longer than the maximum model length of 32768
  /maximum model length (?:is|of) (\d[\d,]*)/i,
  // 中转：context_length_exceeded … limit of 272000 tokens。只认紧贴 is/of 的措辞，不把 max_tokens 等当窗口
  /context_length_exceeded[\s\S]*?\b(?:limit|maximum|window)\s+(?:is|of)\s+(\d[\d,]*)/i,
];

/** 从上下文超限的报错文字里取出服务端给的窗口上限；不是溢出报错或取不到时返回 undefined。纯函数。 */
export function parseOverflowLimit(message: string): number | undefined {
  for (const pattern of OVERFLOW_PATTERNS) {
    const digits = pattern.exec(message)?.[1];
    if (!digits) continue;
    const limit = Number(digits.replace(/,/g, ''));
    if (Number.isSafeInteger(limit) && limit >= MIN_WINDOW) return limit;
  }
  return undefined;
}

/** 服务端在 max_tokens 超范围报错里报的最大输出（各家措辞），按顺序匹配第一个；都要求紧挨 max_tokens */
const MAX_OUTPUT_PATTERNS: readonly RegExp[] = [
  // 智谱：max_tokens参数非法：限制数值范围[1,131072]，取区间上界
  /max_tokens[^[\]\n]{0,40}\[\s*\d+\s*,\s*(\d+)\s*\]/i,
  // Anthropic：max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens
  /max_tokens:\s*\d+\s*>\s*(\d+),?\s*which is the maximum allowed/i,
  // OpenAI：max_tokens is too large: 200000. This model supports at most 128000 completion tokens
  /max_tokens[^\n]{0,80}?supports at most (\d+) completion tokens/i,
  // max_tokens must be less than or equal to `131072`
  /max_tokens[^.\n]{0,40}?must be less than or equal to [`'"]?(\d+)/i,
];

/** 从 max_tokens 超范围的报错文字里取出服务端允许的最大输出；取不到时返回 undefined。纯函数。 */
export function parseMaxOutputLimit(message: string): number | undefined {
  for (const pattern of MAX_OUTPUT_PATTERNS) {
    const digits = pattern.exec(message)?.[1];
    if (!digits) continue;
    const limit = Number(digits);
    if (isPositiveInt(limit)) return limit;
  }
  return undefined;
}

export interface ModelLimitsProber {
  /**
   * 设置条目缺 contextWindow 时探测（服务端列表 → models.dev，取第一个查到的）并只补缺失的字段。
   * 同一服务 + 模型在一次运行里只探测一次，并发调用共用一次。写回了返回 true；从不 reject。
   */
  ensure(providerId: string, modelId: string): Promise<boolean>;
  /**
   * 溢出报错里有窗口上限时写回（覆盖已有值：端点自己报的最可信）；max_tokens 超范围报错里有最大输出上限时，
   * 比已有值小（或没有值）才写回，且不超过窗口。写回了返回 true；从不 reject。
   */
  learn(providerId: string, modelId: string, message: string): Promise<boolean>;
}

export function createModelLimitsProber(options: {
  store: Pick<ProviderStore, 'get' | 'updateModelLimits'>;
  fetch: FetchLike;
  catalog: ModelsDevCatalog;
  log?: LogFn;
}): ModelLimitsProber {
  const { store, catalog } = options;
  const log: LogFn = options.log ?? (() => undefined);
  const probes = new Map<string, Promise<boolean>>();

  /** 服务端列表里同名条目带的元数据；没 key、请求失败或没带窗口时为 undefined */
  async function fromServer(
    provider: StoredProvider,
    modelId: string
  ): Promise<ModelLimits | undefined> {
    if (!provider.apiKey) return undefined;
    const listed = await listRemoteModels(
      {
        api: provider.api,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        apiKey: provider.apiKey,
        savedModelIds: [],
      },
      { fetch: options.fetch, timeoutMs: PROBE_TIMEOUT_MS }
    );
    const model = listed.ok ? listed.models.find((entry) => entry.id === modelId) : undefined;
    return model?.contextWindow
      ? {
          contextWindow: model.contextWindow,
          ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
        }
      : undefined;
  }

  async function probe(providerId: string, modelId: string): Promise<boolean> {
    const provider = await store.get(providerId);
    const entry = provider?.models.find((model) => model.id === modelId);
    if (!provider || !entry || entry.contextWindow) return false;
    const limits = (await fromServer(provider, modelId)) ?? (await catalog.lookup(modelId));
    if (!limits?.contextWindow) {
      log('info', `model ${modelId}: context window not found on the service or models.dev`);
      return false;
    }
    return store.updateModelLimits(providerId, modelId, limits);
  }

  return {
    ensure(providerId, modelId) {
      const key = `${providerId}\n${modelId}`;
      let pending = probes.get(key);
      if (!pending) {
        pending = probe(providerId, modelId).catch(() => {
          // 不带原始错误：读写 providers.json 的错误可能引用文件片段（含 key）
          log('warn', `model ${modelId}: probing the context window failed`);
          return false;
        });
        probes.set(key, pending);
      }
      return pending;
    },
    async learn(providerId, modelId, message) {
      const contextWindow = parseOverflowLimit(message);
      const maxOutput = parseMaxOutputLimit(message);
      let updated = false;
      if (contextWindow) {
        try {
          updated = await store.updateModelLimits(providerId, modelId, { contextWindow }, true);
        } catch {
          log('warn', `model ${modelId}: saving the context window from an overflow error failed`);
        }
      }
      if (maxOutput) {
        try {
          const entry = (await store.get(providerId))?.models.find((model) => model.id === modelId);
          const limit = Math.min(maxOutput, entry?.contextWindow ?? maxOutput);
          if (entry && (entry.maxOutput === undefined || limit < entry.maxOutput)) {
            const saved = await store.updateModelLimits(
              providerId,
              modelId,
              { maxOutput: limit },
              true
            );
            updated = saved || updated;
          }
        } catch {
          log('warn', `model ${modelId}: saving the max output from a max_tokens error failed`);
        }
      }
      return updated;
    },
  };
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
