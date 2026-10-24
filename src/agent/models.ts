import { join } from 'node:path';
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import { isThinkingLevel, type ThinkingLevel } from '@fynvra/core';
import type { ModelQuery, ResolvedModelSpec } from '@shared/types/agent';
import { type ModelThinkingCapability, pickThinkingLevel } from '@shared/types/chat';

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

/** pi 目录里查不到的模型用保守默认值 */
const FALLBACK_LIMITS = { contextWindow: 128_000, maxTokens: 32_000 } as const;

/** Main 的运行时 provider 键都带这个前缀，与 pi 内置目录的 provider 名分开 */
const MODEL_PROVIDER_PREFIX = 'fynvra-';

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
  /** 模型的思考档位：与 resolve 注册的是同一份定义，界面列出的档位就是 pi 接受的档位 */
  describe(query: ModelQuery): ModelThinkingCapability;
}

/**
 * 按 spec.providerId 注册 pi provider。它是 Main 算好的运行时键（`fynvra-` + baseUrl 与 key 的哈希）：
 * 端点和 key 都相同的服务共用一个 provider，换了 key 就是新 provider，同进程的会话不会互相覆盖凭证；
 * 键里没有 key 或端点的明文，日志与用量事件里不会露出来。
 * key 用 setRuntimeApiKey 只放在内存：不写 auth.json，也不经 pi 的配置值解析
 * （registerProvider 的 apiKey 会把 `$VAR` 当环境变量、把 `!cmd` 当 shell 命令执行）。
 * 能力（上下文、thinking、价格）尽量取 pi 目录里同 id 同 api 的模型（官方 provider 优先），
 * 查不到就用 spec 的字段加保守默认值，是否推理按设置里的 reasoning 标记。
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

      const definition = definitionFor(spec, findTemplate(runtime, spec));
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
      return capabilityOf(definitionFor(query, findTemplate(runtime, query)));
    },
  };
}

/** pi 目录里同 id 同协议的模型；官方 provider 的条目优先（见 OFFICIAL_PROVIDERS） */
function findTemplate(runtime: ModelRuntime, query: ModelQuery): Model<Api> | undefined {
  const candidates = runtime
    .getModels()
    .filter(
      (model) =>
        !model.provider.startsWith(MODEL_PROVIDER_PREFIX) &&
        model.id === query.modelId &&
        model.api === query.api
    );
  const official = OFFICIAL_PROVIDERS[query.api];
  return candidates.find((model) => model.provider === official) ?? candidates[0];
}

/**
 * pi 给模型的可选档位（reasoning 与 thinkingLevelMap：映射为 null 的不可选，xhigh 要显式映射），
 * 只留 fynvra 的 ThinkingLevel 里有的（pi 另有 max）；默认档位是 pi 的默认 medium 按模型能力 clamp。
 */
function capabilityOf(definition: ModelDefinition): ModelThinkingCapability {
  if (!definition.reasoning) return { thinkingLevels: [] };
  const model: Model<Api> = {
    ...definition,
    api: definition.api ?? ('' as Api),
    provider: 'fynvra-capability',
    baseUrl: '',
  };
  const thinkingLevels = getSupportedThinkingLevels(model).filter(isThinkingLevel);
  if (thinkingLevels.length === 0) return { thinkingLevels };
  const clamped = clampThinkingLevel(model, PI_DEFAULT_THINKING);
  const defaultThinking: ThinkingLevel = isThinkingLevel(clamped)
    ? clamped
    : (thinkingLevels.at(-1) as ThinkingLevel);
  return { thinkingLevels, defaultThinking };
}

function definitionFor(
  spec: ModelQuery & Pick<ResolvedModelSpec, 'reasoning'>,
  template: Model<Api> | undefined
): ModelDefinition {
  if (!template) {
    return {
      id: spec.modelId,
      name: spec.modelId,
      api: spec.api as Api,
      reasoning: spec.reasoning === true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...FALLBACK_LIMITS,
    };
  }
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
