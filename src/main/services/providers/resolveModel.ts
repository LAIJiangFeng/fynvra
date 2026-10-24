import { createHash } from 'node:crypto';
import { isThinkingLevel, type ThinkingLevel } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { resolveBaseUrl } from '@shared/modelCatalog';
import { getProviderStore } from '../../ipc/providers';
import type { ProviderStore, StoredProvider } from './providerStore';

// §9.5 的 ModelResolver / ResolvedModelSpec 归 agent-host（src/main/services/agentHost/types.ts），
// 本卡不能动 agentHost/**，这里按同一形状声明，结构类型可以直接赋给 agent-host 的接口。

/** 跨进程可序列化的模型描述；worker 进程内再换成 agent-runtime 的 ResolvedModel。 */
export interface ResolvedModelSpec {
  /** 运行时 provider 键（见 runtimeProviderId），不是设置里的服务 id */
  providerId: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  thinking?: ThinkingLevel;
}

/** 角色或会话的模型引用；`thinking` 可选，Role.model 可以直接传进来。 */
export interface ModelRef {
  providerId: string;
  modelId: string;
  thinking?: ThinkingLevel;
}

export interface ModelResolver {
  resolve(
    ref: ModelRef | undefined
  ): Promise<{ ok: true; model: ResolvedModelSpec } | { ok: false; error: string }>;
}

type ResolveResult = Awaited<ReturnType<ModelResolver['resolve']>>;

/**
 * 运行时 provider 键：同一 baseUrl + apiKey 的多个服务对应同一个 pi provider，worker 只需注册一次；
 * 换了 key 键也随之改变，长驻的 worker 不会继续用旧凭证。协议在模型上（pi 的 ProviderModelConfig.api），
 * 所以同一端点下混用协议也没有问题。取哈希，key 明文不会出现在 provider 名、日志或 usage 事件里。
 */
export function runtimeProviderId(baseUrl: string, apiKey: string): string {
  const digest = createHash('sha256').update(`${baseUrl}\n${apiKey}`).digest('hex');
  return `fynvra-${digest.slice(0, 16)}`;
}

/**
 * §9.5 ModelResolver：从 providers.json 解析模型引用。每次 resolve 都重新读注册表（内存缓存），
 * 设置页的修改对之后新建的会话立即生效。不指定模型时取第一个启用、有 key、有模型的服务的第一个模型。
 */
export function createModelResolver(source?: Pick<ProviderStore, 'list'>): ModelResolver {
  return {
    async resolve(ref) {
      let providers: StoredProvider[];
      try {
        providers = await (source ?? getProviderStore()).list();
      } catch (error) {
        return { ok: false, error: `读取模型服务失败：${errorMessage(error)}` };
      }
      return ref ? resolveRef(providers, ref) : resolveDefault(providers);
    },
  };
}

function resolveRef(providers: StoredProvider[], ref: ModelRef): ResolveResult {
  const provider = providers.find((candidate) => candidate.id === ref.providerId);
  if (!provider) {
    return { ok: false, error: `模型服务 ${ref.providerId} 不存在，请在「设置 → 模型服务」中添加` };
  }
  if (!provider.enabled) return { ok: false, error: `模型服务「${provider.name}」已停用` };
  if (!provider.models.some((model) => model.id === ref.modelId)) {
    return { ok: false, error: `模型服务「${provider.name}」没有模型 ${ref.modelId}` };
  }
  return toSpec(provider, ref.modelId, ref.thinking);
}

function resolveDefault(providers: StoredProvider[]): ResolveResult {
  for (const provider of providers) {
    const [model] = provider.models;
    if (provider.enabled && provider.apiKey && model) return toSpec(provider, model.id);
  }
  return {
    ok: false,
    error: '还没有可用的模型服务：请在「设置 → 模型服务」中添加并启用一个填写了 API Key 的服务',
  };
}

function toSpec(provider: StoredProvider, modelId: string, thinking?: unknown): ResolveResult {
  const { apiKey } = provider;
  if (!apiKey) return { ok: false, error: `模型服务「${provider.name}」还没有填写 API Key` };
  const baseUrl = resolveBaseUrl(provider.api, provider.baseUrl);
  return {
    ok: true,
    model: {
      providerId: runtimeProviderId(baseUrl, apiKey),
      api: provider.api,
      baseUrl,
      apiKey,
      modelId,
      ...(isThinkingLevel(thinking) ? { thinking } : {}),
    },
  };
}
