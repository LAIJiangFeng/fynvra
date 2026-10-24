import { join } from 'node:path';
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import type { ThinkingLevel } from '@fynvra/core';
import type { ModelQuery, ResolvedModelSpec } from '@shared/types/agent';
import {
  type ModelThinkingCapability,
  pickThinkingLevel,
  type ThinkingSource,
} from '@shared/types/chat';

type ModelDefinition = Extract<
  NonNullable<Parameters<ModelRuntime['registerProvider']>[1]['models']>[number],
  { reasoning: boolean }
>;

/** spec 没给 baseUrl 时使用的官方端点 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-completions': 'https://api.openai.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * 各协议的官方 provider。pi 目录里同 id 同协议的模型常出现在好几个 provider 下（网关、代理），
 * 上下文、价格、思考档位映射各不相同（如 cloudflare-ai-gateway 的 gpt-5.5 写 1M 上下文、没有 off）；
 * 先取官方的，没有再取目录里第一个。
 */
const OFFICIAL_PROVIDERS: Readonly<Record<string, string>> = {
  'anthropic-messages': 'anthropic',
  'openai-responses': 'openai',
  'openai-completions': 'openai',
  'google-generative-ai': 'google',
};

/** pi 新会话的默认思考档位（pi-coding-agent 的 DEFAULT_THINKING_LEVEL）：按模型能力 clamp 后就是模型的默认档位 */
const PI_DEFAULT_THINKING = 'medium';

/** pi 目录里查不到、也推断不出的模型用保守默认值 */
const FALLBACK_LIMITS = { contextWindow: 128_000, maxTokens: 32_000 } as const;

/** Main 的运行时 provider 键都带这个前缀，与 pi 内置目录的 provider 名分开 */
const MODEL_PROVIDER_PREFIX = 'fynvra-';

// 目录里找不到、也推断不出的模型（设置里标了推理）按协议兜底的档位：
// Anthropic 取 pi 对当前一代 Claude 的档位；OpenAI 两种协议固定 low / medium / high / xhigh；
// Google 取目录里版本号最大的 Gemini 的档位；其他协议沿用 pi 对「推理、没有档位映射」的默认集合。
const ANTHROPIC_FALLBACK_MODEL = 'claude-opus-5-5';
const OPENAI_FALLBACK_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: null,
};

/**
 * 推断时规整 id 要反复去掉的后缀：-latest、-preview 与日期（YYYYMMDD、MM-YYYY、MM-DD、四位数）。
 * YYYY-MM-DD 不用单列：先按 MM-DD 去掉，剩下的四位年份下一轮再去掉。
 */
const VERSION_TAG_SUFFIX = /-(?:latest|preview|\d{8}|\d{2}-\d{4}|\d{2}-\d{2}|\d{4})$/;
/** 按段比较 id：- 与 . 都分段（gpt-6.1-sol → gpt / 6 / 1 / sol），变体名整段比较 */
const SEGMENT_SEPARATOR = /[-.]/;
/** 至少共享这么多段才算接近：只共享家族名（gpt / claude / gemini）不算 */
const MIN_SHARED_SEGMENTS = 2;
const NATURAL_ORDER = new Intl.Collator('en', { numeric: true });

/** 一个 worker 进程共享一个 ModelRuntime；只读 fynvra 的 agentDir，模型目录不联网刷新 */
export function createWorkerModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

export interface ModelRegistry {
  /**
   * Main 交来的可序列化模型描述 → agent-runtime 的 ResolvedModel；失败抛错（由 spawn 转成 session-error）。
   * 思考档位按 {@link pickThinkingLevel} 落到模型的可选集合里。
   */
  resolve(spec: ResolvedModelSpec): Promise<ResolvedModel>;
  /** 模型的思考档位与来源：与 resolve 注册的是同一份定义，界面列出的档位就是 pi 接受的档位 */
  describe(query: ModelQuery): ModelThinkingCapability;
}

/**
 * 按 spec.providerId 注册 pi provider。它是 Main 算好的运行时键（`fynvra-` + baseUrl 与 key 的哈希）：
 * 端点和 key 都相同的服务共用一个 provider，换了 key 就是新 provider，同进程的会话不会互相覆盖凭证；
 * 键里没有 key 或端点的明文，日志与用量事件里不会露出来。
 * key 用 setRuntimeApiKey 只放在内存：不写 auth.json，也不经 pi 的配置值解析
 * （registerProvider 的 apiKey 会把 `$VAR` 当环境变量、把 `!cmd` 当 shell 命令执行）。
 * 能力（上下文、thinking、价格）取 pi 目录里同 id 同 api 的模型（官方 provider 优先），
 * 目录里没有就按目录里最接近的模型推断，都不行才用 spec 的字段加保守默认值（见 {@link defineModel}）。
 */
export function createModelRegistry(runtime: ModelRuntime): ModelRegistry {
  /** registerProvider 整体替换模型列表：同一 provider 的模型要累积 */
  const definitions = new Map<string, Map<string, ModelDefinition>>();

  return {
    async resolve(spec) {
      const { providerId } = spec;
      // 不带前缀的名字可能就是 pi 内置的 provider（如 anthropic），注册会替换掉它的整个模型目录
      if (!providerId.startsWith(MODEL_PROVIDER_PREFIX)) {
        throw new Error(
          `model provider "${providerId}" is not a runtime provider key ("${MODEL_PROVIDER_PREFIX}…")`
        );
      }
      const baseUrl = spec.baseUrl ?? DEFAULT_BASE_URLS[spec.api];
      if (!baseUrl) {
        throw new Error(
          `no base URL for ${providerId}/${spec.modelId}: api "${spec.api}" has no default endpoint`
        );
      }

      const { definition } = defineModel(runtime, spec);
      const models = definitions.get(providerId) ?? new Map<string, ModelDefinition>();
      models.set(spec.modelId, definition);
      definitions.set(providerId, models);
      runtime.registerProvider(providerId, {
        name: providerId,
        api: spec.api as Api,
        baseUrl,
        models: [...models.values()],
      });
      if (spec.apiKey) await runtime.setRuntimeApiKey(providerId, spec.apiKey);

      const model = runtime.getModel(providerId, spec.modelId);
      if (!model) throw new Error(`model ${spec.modelId} is missing after registration`);
      const thinking = pickThinkingLevel(capabilityOf(definition), spec.thinking);
      return { runtime, model, ...(thinking ? { thinking } : {}) };
    },
    describe(query) {
      const { definition, source } = defineModel(runtime, query);
      return { ...capabilityOf(definition), source };
    },
  };
}

/**
 * 模型在 pi 里的定义与档位来源：
 * 1. 目录里同协议、同 id 的模型（官方 provider 优先）→ `catalog`；
 * 2. 否则找目录里同协议最接近的模型（{@link findClosestModel}）→ `inferred:<id>`：能力照搬它（档位映射、
 *    兼容开关、上下文、价格），id 与名字仍是设置里的；是否推理也看它，不看设置里的标记；
 * 3. 都没有 → `fallback`：保守上限；设置里标了推理才是推理模型，档位按协议兜底（{@link fallbackLevelMap}）。
 */
function defineModel(
  runtime: ModelRuntime,
  spec: ModelQuery & Pick<ResolvedModelSpec, 'reasoning'>
): { definition: ModelDefinition; source: ThinkingSource } {
  const catalog = catalogOf(runtime, spec.api);
  const official = OFFICIAL_PROVIDERS[spec.api];
  const sameId = catalog.filter((model) => model.id === spec.modelId);
  const exact = sameId.find((model) => model.provider === official) ?? sameId[0];
  if (exact) return { definition: definitionFor(spec, exact), source: 'catalog' };
  const closest = findClosestModel(catalog, spec.modelId, official);
  if (closest) {
    return {
      definition: { ...definitionFor(spec, closest), name: spec.modelId },
      source: `inferred:${closest.id}`,
    };
  }
  return { definition: fallbackDefinition(spec, catalog), source: 'fallback' };
}

/** pi 目录里某个协议的模型（不含 fynvra 自己注册的运行时 provider） */
function catalogOf(runtime: ModelRuntime, api: string): Model<Api>[] {
  return runtime
    .getModels()
    .filter((model) => !model.provider.startsWith(MODEL_PROVIDER_PREFIX) && model.api === api);
}

/** 推断用的 id 规整：小写，去掉 […]（如 Claude Code 的 [1m]），反复去掉日期 / -latest / -preview 后缀 */
export function normalizeModelId(id: string): string {
  let normalized = id
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(VERSION_TAG_SUFFIX, '');
  } while (normalized !== previous);
  return normalized;
}

interface CatalogEntry<T> {
  model: T;
  normalized: string;
  segments: string[];
}

/**
 * 目录里与 modelId 最接近的模型：两边的 id 都先规整（{@link normalizeModelId}），再按段比较。
 * 规整后相同的最近；否则从完整 id 起逐段退让（gpt-6.2-sol → gpt-6.2 → gpt-6），取第一个有模型以它开头的前缀，
 * 至少要共享两段（只共享 gpt / claude 这样的家族名不算接近）。同一前缀下的挑法见 {@link closestOf}。
 */
export function findClosestModel<T extends { id: string; provider: string }>(
  candidates: readonly T[],
  modelId: string,
  officialProvider?: string
): T | undefined {
  const normalizedQuery = normalizeModelId(modelId);
  const query = normalizedQuery.split(SEGMENT_SEPARATOR);
  const entries = candidates.map((model): CatalogEntry<T> => {
    const normalized = normalizeModelId(model.id);
    return { model, normalized, segments: normalized.split(SEGMENT_SEPARATOR) };
  });
  const same = entries.filter((entry) => entry.normalized === normalizedQuery);
  if (same.length > 0) return closestOf(same, query, query.length, officialProvider);
  for (let shared = query.length; shared >= MIN_SHARED_SEGMENTS; shared--) {
    const prefix = query.slice(0, shared);
    const found = entries.filter((entry) =>
      prefix.every((segment, index) => entry.segments[index] === segment)
    );
    if (found.length > 0) return closestOf(found, query, shared, officialProvider);
  }
  return undefined;
}

/**
 * 共享了前 shared 段的候选里挑一个：官方 provider 的优先；再看下一段的版本号谁离得近（claude-opus-4-0 取 4-5
 * 而不是 4-8），多出来的段谁最少，谁的版本最新（自然序最大）；最后取 id 较短的（别名先于带日期的版本）。
 */
function closestOf<T extends { id: string; provider: string }>(
  found: readonly CatalogEntry<T>[],
  query: readonly string[],
  shared: number,
  officialProvider: string | undefined
): T | undefined {
  const official = found.filter((entry) => entry.model.provider === officialProvider);
  const pool = official.length > 0 ? official : found;
  const wanted = versionOf(query[shared]);
  const distance = (entry: CatalogEntry<T>) =>
    wanted === undefined ? 0 : Math.abs(wanted - (versionOf(entry.segments[shared]) ?? 0));
  return [...pool].sort(
    (a, b) =>
      distance(a) - distance(b) ||
      a.segments.length - b.segments.length ||
      NATURAL_ORDER.compare(b.normalized, a.normalized) ||
      a.model.id.length - b.model.id.length
  )[0]?.model;
}

function versionOf(segment: string | undefined): number | undefined {
  return segment !== undefined && /^\d+$/.test(segment) ? Number(segment) : undefined;
}

/**
 * 模型可选的档位：pi 的 getSupportedThinkingLevels（reasoning 与 thinkingLevelMap：映射为 null 的不可选，
 * xhigh / max 要显式映射），pi 的档位与 fynvra 的 ThinkingLevel 是同一组；默认档位是 pi 的默认 medium 按模型能力 clamp。
 */
function capabilityOf(definition: ModelDefinition): ModelThinkingCapability {
  if (!definition.reasoning) return { thinkingLevels: [] };
  const model: Model<Api> = {
    ...definition,
    api: definition.api ?? ('' as Api),
    provider: 'fynvra-capability',
    baseUrl: '',
  };
  const thinkingLevels: ThinkingLevel[] = getSupportedThinkingLevels(model);
  if (thinkingLevels.length === 0) return { thinkingLevels };
  return { thinkingLevels, defaultThinking: clampThinkingLevel(model, PI_DEFAULT_THINKING) };
}

/** 照搬目录模型的能力；id 用 spec 的（请求里发的是设置里的 id） */
function definitionFor(spec: ModelQuery, template: Model<Api>): ModelDefinition {
  return {
    id: spec.modelId,
    name: template.name,
    api: spec.api as Api,
    reasoning: template.reasoning,
    input: [...template.input],
    cost: { ...template.cost },
    contextWindow: template.contextWindow,
    maxTokens: template.maxTokens,
    ...(template.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
    ...(template.promptCache ? { promptCache: template.promptCache } : {}),
    ...(template.inputLimits ? { inputLimits: template.inputLimits } : {}),
    ...(template.compat ? { compat: template.compat } : {}),
  };
}

/** 目录外又推断不出的模型：spec 的字段加保守默认值；设置里标了推理时带上协议兜底的档位映射 */
function fallbackDefinition(
  spec: ModelQuery & Pick<ResolvedModelSpec, 'reasoning'>,
  catalog: readonly Model<Api>[]
): ModelDefinition {
  const reasoning = spec.reasoning === true;
  const thinkingLevelMap = reasoning ? fallbackLevelMap(catalog, spec.api) : undefined;
  return {
    id: spec.modelId,
    name: spec.modelId,
    api: spec.api as Api,
    reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...FALLBACK_LIMITS,
    ...(thinkingLevelMap ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
  };
}

/** 按协议兜底的档位映射（见文件头部的说明）；undefined 即 pi 的默认集合 off / minimal / low / medium / high */
function fallbackLevelMap(
  catalog: readonly Model<Api>[],
  api: string
): ThinkingLevelMap | undefined {
  const official = catalog.filter((model) => model.provider === OFFICIAL_PROVIDERS[api]);
  switch (api) {
    case 'anthropic-messages':
      return official.find((model) => model.id === ANTHROPIC_FALLBACK_MODEL)?.thinkingLevelMap;
    case 'openai-responses':
    case 'openai-completions':
      return OPENAI_FALLBACK_LEVELS;
    case 'google-generative-ai':
      return newestGemini(official)?.thinkingLevelMap;
    default:
      return undefined;
  }
}

/** 版本号最大的推理 Gemini（gemini-<版本>-…，按自然序比较规整后的 id） */
function newestGemini(models: readonly Model<Api>[]): Model<Api> | undefined {
  let newest: Model<Api> | undefined;
  for (const model of models) {
    if (!model.reasoning || !/^gemini-\d/.test(model.id)) continue;
    if (
      !newest ||
      NATURAL_ORDER.compare(normalizeModelId(model.id), normalizeModelId(newest.id)) > 0
    ) {
      newest = model;
    }
  }
  return newest;
}
