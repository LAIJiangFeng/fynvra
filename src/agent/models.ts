import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import type { ResolvedModelSpec } from '@shared/types/agent';

type ModelDefinition = NonNullable<
  Parameters<ModelRuntime['registerProvider']>[1]['models']
>[number];

/** spec 没给 baseUrl、pi 目录里该 provider 也没有同 api 的模型时使用的官方端点 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-completions': 'https://api.openai.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

/** pi 目录里查不到的模型用保守默认值 */
const FALLBACK_LIMITS = { contextWindow: 128_000, maxTokens: 32_000 } as const;

export const MODEL_PROVIDER_PREFIX = 'fynvra-';

/** 一个 worker 进程共享一个 ModelRuntime；只读 fynvra 的 agentDir，模型目录不联网刷新 */
export function createWorkerModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

export interface ModelRegistry {
  /** Main 交来的可序列化模型描述 → agent-runtime 的 ResolvedModel；失败抛错（由 spawn 转成 session-error） */
  resolve(spec: ResolvedModelSpec): Promise<ResolvedModel>;
}

/**
 * 每个（api, baseUrl, apiKey）注册成一个独立 provider：同进程的会话共享 ModelRuntime，不同 key 不能互相覆盖。
 * key 用 setRuntimeApiKey 只放在内存：不写 auth.json，也不经 pi 的配置值解析
 * （registerProvider 的 apiKey 会把 `$VAR` 当环境变量、把 `!cmd` 当 shell 命令执行）。
 * 能力（上下文、thinking、价格）尽量取 pi 目录里同 id 同 api 的模型。
 */
export function createModelRegistry(runtime: ModelRuntime): ModelRegistry {
  /** registerProvider 整体替换模型列表：同一 provider 的模型要累积 */
  const definitions = new Map<string, Map<string, ModelDefinition>>();

  return {
    async resolve(spec) {
      const catalog = runtime
        .getModels()
        .filter((model) => !model.provider.startsWith(MODEL_PROVIDER_PREFIX));
      const template =
        catalog.find((model) => model.provider === spec.providerId && matches(model, spec)) ??
        catalog.find((model) => matches(model, spec));
      const baseUrl =
        spec.baseUrl ??
        catalog.find((model) => model.provider === spec.providerId && model.api === spec.api)
          ?.baseUrl ??
        DEFAULT_BASE_URLS[spec.api];
      if (!baseUrl) {
        throw new Error(
          `no base URL for ${spec.providerId}/${spec.modelId}: api "${spec.api}" has no default endpoint`
        );
      }

      const providerId = providerKey(spec.api, baseUrl, spec.apiKey);
      const models = definitions.get(providerId) ?? new Map<string, ModelDefinition>();
      models.set(spec.modelId, definitionFor(spec, template));
      definitions.set(providerId, models);
      runtime.registerProvider(providerId, {
        name: spec.providerId,
        api: spec.api as Api,
        baseUrl,
        models: [...models.values()],
      });
      if (spec.apiKey) await runtime.setRuntimeApiKey(providerId, spec.apiKey);

      const model = runtime.getModel(providerId, spec.modelId);
      if (!model) throw new Error(`model ${spec.modelId} is missing after registration`);
      return { runtime, model, ...(spec.thinking ? { thinking: spec.thinking } : {}) };
    },
  };
}

function matches(model: Model<Api>, spec: ResolvedModelSpec): boolean {
  return model.id === spec.modelId && model.api === spec.api;
}

/** provider 键只含哈希：日志与用量事件里不会露出 key 或端点 */
export function providerKey(api: string, baseUrl: string, apiKey = ''): string {
  const endpoint = createHash('sha256').update(`${api}\0${baseUrl}`).digest('hex').slice(0, 12);
  const key = createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
  return `${MODEL_PROVIDER_PREFIX}${endpoint}-${key}`;
}

function definitionFor(spec: ResolvedModelSpec, template: Model<Api> | undefined): ModelDefinition {
  if (!template) {
    return {
      id: spec.modelId,
      name: spec.modelId,
      api: spec.api as Api,
      reasoning: false,
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
