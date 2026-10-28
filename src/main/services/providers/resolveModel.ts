import { createHash } from 'node:crypto';
import { isThinkingLevel, type ThinkingLevel } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { resolveBaseUrl } from '@shared/modelCatalog';
import { supportsFastMode } from '@shared/modelFast';
import { translate } from '../../i18n';
import { getProviderStore } from '../../ipc/providers';
import type { ModelRef, ModelResolver } from '../agentHost/types';
import type { ProviderStore, StoredProvider } from './providerStore';

/** Role.model 也可以直接当引用传入：带着的 thinking / fastMode 写进 spec。 */
type RoleModelRef = ModelRef & { thinking?: ThinkingLevel };

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
 * 结果里的 `ref` 是解析到的服务 id 与模型 id，`model.providerId` 是运行时 provider 键。
 */
export function createModelResolver(source?: Pick<ProviderStore, 'list'>): ModelResolver {
  return {
    async resolve(ref: RoleModelRef | undefined) {
      let providers: StoredProvider[];
      try {
        providers = await (source ?? getProviderStore()).list();
      } catch (error) {
        return {
          ok: false,
          error: translate('providers.readFailed', { error: errorMessage(error) }),
        };
      }
      return ref ? resolveRef(providers, ref) : resolveDefault(providers);
    },
  };
}

function resolveRef(providers: StoredProvider[], ref: RoleModelRef): ResolveResult {
  const provider = providers.find((candidate) => candidate.id === ref.providerId);
  if (!provider) {
    return { ok: false, error: translate('providers.providerMissing', { id: ref.providerId }) };
  }
  if (!provider.enabled)
    return { ok: false, error: translate('providers.providerDisabled', { name: provider.name }) };
  if (!provider.models.some((model) => model.id === ref.modelId)) {
    return {
      ok: false,
      error: translate('providers.modelMissing', { name: provider.name, model: ref.modelId }),
    };
  }
  return toSpec(provider, ref.modelId, ref.thinking, ref.fastMode);
}

function resolveDefault(providers: StoredProvider[]): ResolveResult {
  for (const provider of providers) {
    const [model] = provider.models;
    if (provider.enabled && provider.apiKey && model) return toSpec(provider, model.id);
  }
  return {
    ok: false,
    error: translate('providers.noProviders'),
  };
}

function toSpec(
  provider: StoredProvider,
  modelId: string,
  thinking?: unknown,
  fastMode?: unknown
): ResolveResult {
  const { apiKey } = provider;
  if (!apiKey)
    return { ok: false, error: translate('providers.noApiKeyFor', { name: provider.name }) };
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
      // Main 也在这里校验协议：切到不支持 Fast 的服务时清掉，不把旧开关带进请求
      ...(fastMode === true && supportsFastMode(provider.api) ? { fastMode: true } : {}),
    },
    ref: { providerId: provider.id, modelId },
  };
}
