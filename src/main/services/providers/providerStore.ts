import { asRecord } from '@shared/guards';
import { isProviderApi } from '@shared/modelCatalog';
import type { ModelEntry, ModelProvider, ModelProviderView } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';
import { createJsonRegistry, isRegistryId, toSlug, uniqueId } from './jsonRegistry';

/** providers.json 里的一条记录：§9.6 的 ModelProvider 加明文 key。只存在于 Main。 */
export interface StoredProvider extends ModelProvider {
  apiKey?: string;
}

export type ProviderUpsertOutcome =
  | { ok: true; provider: StoredProvider }
  | { ok: false; error: string };

export interface ProviderStore {
  /** 全部服务（含明文 key），仅供 Main 内部使用；给 Renderer 的一律经 toProviderView。 */
  list(): Promise<StoredProvider[]>;
  get(id: string): Promise<StoredProvider | undefined>;
  /** 入参须先经 parseProviderUpsert。无 id 为新建（id 按名称生成），有 id 为整条替换。 */
  upsert(input: ProviderUpsertInput): Promise<ProviderUpsertOutcome>;
  /** id 不存在时返回 false。 */
  remove(id: string): Promise<boolean>;
}

/** `userData/providers.json`：模型服务与明文 API key，原子写。 */
export function createProviderStore(options: {
  filePath: string;
  now?: () => number;
}): ProviderStore {
  const registry = createJsonRegistry<StoredProvider>({
    ...options,
    key: 'providers',
    parseEntry: parseStoredProvider,
  });

  return {
    list: () => registry.list(),
    async get(id) {
      return (await registry.list()).find((provider) => provider.id === id);
    },
    upsert: (input) =>
      registry.transact((providers): { next?: StoredProvider[]; result: ProviderUpsertOutcome } => {
        if (input.id === undefined) {
          const id = uniqueId(
            toSlug(input.name, 'provider'),
            providers.map((provider) => provider.id)
          );
          const provider = buildProvider(id, input, input.apiKey ?? undefined);
          return { next: [...providers, provider], result: { ok: true, provider } };
        }
        const index = providers.findIndex((provider) => provider.id === input.id);
        const current = providers[index];
        if (!current) return { result: { ok: false, error: `模型服务 ${input.id} 不存在` } };
        const apiKey = input.apiKey === undefined ? current.apiKey : (input.apiKey ?? undefined);
        const provider = buildProvider(current.id, input, apiKey);
        return { next: providers.with(index, provider), result: { ok: true, provider } };
      }),
    remove: (id) =>
      registry.transact((providers) => {
        const next = providers.filter((provider) => provider.id !== id);
        return next.length === providers.length ? { result: false } : { next, result: true };
      }),
  };
}

function buildProvider(
  id: string,
  input: ProviderUpsertInput,
  apiKey: string | undefined
): StoredProvider {
  return {
    id,
    name: input.name,
    api: input.api,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    enabled: input.enabled,
    models: input.models.map((model) => ({ ...model })),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** key 至少这么长才给末 4 位提示，避免短 key 被看出大半。 */
const MIN_KEY_LENGTH_FOR_HINT = 8;

/** 给 Renderer 的脱敏视图：逐字段构造（不是展开后删除），明文 key 不可能被带出去。 */
export function toProviderView(provider: StoredProvider): ModelProviderView {
  const { apiKey } = provider;
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    enabled: provider.enabled,
    models: provider.models.map((model) => ({ ...model })),
    hasApiKey: Boolean(apiKey),
    ...(apiKey && apiKey.length >= MIN_KEY_LENGTH_FOR_HINT ? { apiKeyHint: apiKey.slice(-4) } : {}),
  };
}

/** 磁盘记录宽松收窄：id / 名称 / 协议不合法整条丢弃，模型逐条丢弃非法项，未知字段丢弃。 */
export function parseStoredProvider(raw: unknown): StoredProvider | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, api, baseUrl, enabled, apiKey } = record;
  if (!isRegistryId(id) || typeof name !== 'string' || !name.trim() || !isProviderApi(api)) {
    return null;
  }
  const models: ModelEntry[] = [];
  for (const item of Array.isArray(record.models) ? record.models : []) {
    const model = parseStoredModel(item);
    if (model && !models.some((existing) => existing.id === model.id)) models.push(model);
  }
  return {
    id,
    name: name.trim(),
    api,
    ...(typeof baseUrl === 'string' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    enabled: typeof enabled === 'boolean' ? enabled : true,
    models,
    ...(typeof apiKey === 'string' && apiKey ? { apiKey } : {}),
  };
}

function parseStoredModel(raw: unknown): ModelEntry | null {
  const record = asRecord(raw);
  const id = typeof record?.id === 'string' ? record.id.trim() : '';
  if (!record || !id) return null;
  const { name, contextWindow, maxOutput, reasoning } = record;
  return {
    id,
    name: (typeof name === 'string' && name.trim()) || id,
    ...(isPositiveInt(contextWindow) ? { contextWindow } : {}),
    ...(isPositiveInt(maxOutput) ? { maxOutput } : {}),
    ...(typeof reasoning === 'boolean' ? { reasoning } : {}),
  };
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
