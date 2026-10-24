import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import type { ResolvedModelSpec } from '@shared/types/agent';

type ModelDefinition = NonNullable<
  Parameters<ModelRuntime['registerProvider']>[1]['models']
>[number];

/** spec 没给 baseUrl 时使用的官方端点 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-completions': 'https://api.openai.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

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
  /** Main 交来的可序列化模型描述 → agent-runtime 的 ResolvedModel；失败抛错（由 spawn 转成 session-error） */
  resolve(spec: ResolvedModelSpec): Promise<ResolvedModel>;
}

/**
 * 按 spec.providerId 注册 pi provider。它是 Main 算好的运行时键（`fynvra-` + baseUrl 与 key 的哈希）：
 * 端点和 key 都相同的服务共用一个 provider，换了 key 就是新 provider，同进程的会话不会互相覆盖凭证；
 * 键里没有 key 或端点的明文，日志与用量事件里不会露出来。
 * key 用 setRuntimeApiKey 只放在内存：不写 auth.json，也不经 pi 的配置值解析
 * （registerProvider 的 apiKey 会把 `$VAR` 当环境变量、把 `!cmd` 当 shell 命令执行）。
 * 能力（上下文、thinking、价格）尽量取 pi 目录里同 id 同 api 的模型，查不到就用 spec 的字段加保守默认值。
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
      const template = runtime
        .getModels()
        .find(
          (model) =>
            !model.provider.startsWith(MODEL_PROVIDER_PREFIX) &&
            model.id === spec.modelId &&
            model.api === spec.api
        );
      const baseUrl = spec.baseUrl ?? DEFAULT_BASE_URLS[spec.api];
      if (!baseUrl) {
        throw new Error(
          `no base URL for ${providerId}/${spec.modelId}: api "${spec.api}" has no default endpoint`
        );
      }

      const models = definitions.get(providerId) ?? new Map<string, ModelDefinition>();
      models.set(spec.modelId, definitionFor(spec, template));
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
      return { runtime, model, ...(spec.thinking ? { thinking: spec.thinking } : {}) };
    },
  };
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
