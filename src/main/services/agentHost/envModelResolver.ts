import type { ModelResolver, ResolvedModelSpec } from './types';

interface EnvProvider {
  providerId: string;
  api: string;
  keyVar: string;
  /** 可选：代理 / 自建网关的端点 */
  baseUrlVar: string;
  defaultModelId: string;
}

/** 按顺序取第一个配了 key 的 provider 作为默认 */
const ENV_PROVIDERS: readonly EnvProvider[] = [
  {
    providerId: 'anthropic',
    api: 'anthropic-messages',
    keyVar: 'FYNVRA_ANTHROPIC_API_KEY',
    baseUrlVar: 'FYNVRA_ANTHROPIC_BASE_URL',
    defaultModelId: 'claude-sonnet-5-5',
  },
  {
    providerId: 'openai',
    api: 'openai-responses',
    keyVar: 'FYNVRA_OPENAI_API_KEY',
    baseUrlVar: 'FYNVRA_OPENAI_BASE_URL',
    defaultModelId: 'gpt-5.5',
  },
];

/** 只该留在 Main 的环境变量：fork agent worker 时从它的环境里去掉（key 只经 spawn-session 交出去） */
export const ENV_MODEL_SECRET_VARS: readonly string[] = ENV_PROVIDERS.map(
  (provider) => provider.keyVar
);

/**
 * 基于环境变量的临时 ModelResolver（§9.5 的注入点）：`FYNVRA_ANTHROPIC_API_KEY` / `FYNVRA_OPENAI_API_KEY`，
 * 可选 `FYNVRA_ANTHROPIC_BASE_URL` / `FYNVRA_OPENAI_BASE_URL`。读不到 key 就返回 `{ ok: false }`。
 * settings-ui 合并后换成 providers/resolveModel.ts 的 createModelResolver()。
 */
export function envModelResolver(
  env: Record<string, string | undefined> = process.env
): ModelResolver {
  return {
    async resolve(ref) {
      const read = (name: string) => env[name]?.trim() || undefined;
      const spec = (provider: EnvProvider, apiKey: string, modelId: string): ResolvedModelSpec => {
        const baseUrl = read(provider.baseUrlVar);
        return {
          providerId: provider.providerId,
          api: provider.api,
          apiKey,
          modelId,
          ...(baseUrl ? { baseUrl } : {}),
        };
      };

      if (!ref) {
        for (const provider of ENV_PROVIDERS) {
          const apiKey = read(provider.keyVar);
          if (apiKey) return { ok: true, model: spec(provider, apiKey, provider.defaultModelId) };
        }
        return {
          ok: false,
          error: `没有可用的模型：请设置 ${ENV_MODEL_SECRET_VARS.join(' 或 ')}（模型设置页上线前的临时方式）`,
        };
      }

      const provider = ENV_PROVIDERS.find((candidate) => candidate.providerId === ref.providerId);
      if (!provider) {
        return {
          ok: false,
          error: `暂不支持模型服务 ${ref.providerId}：环境变量方式只支持 ${ENV_PROVIDERS.map((p) => p.providerId).join(' / ')}`,
        };
      }
      const apiKey = read(provider.keyVar);
      if (!apiKey) return { ok: false, error: `未设置 ${provider.keyVar}` };
      return { ok: true, model: spec(provider, apiKey, ref.modelId) };
    },
  };
}
