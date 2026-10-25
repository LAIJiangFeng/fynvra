import { asRecord } from '@shared/guards';
import { isProviderApi, resolveBaseUrl } from '@shared/modelCatalog';
import type { ModelEntry, ModelProvider, ModelProviderView, ProviderApi } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';
import { translate } from '../../i18n';
import { createJsonRegistry, isRegistryId, toSlug, uniqueId } from './jsonRegistry';
import { MAX_NAME_LENGTH } from './parseProviderInput';

/** providers.json 里的一条记录：§9.6 的 ModelProvider 加明文 key。只存在于 Main。 */
export interface StoredProvider extends ModelProvider {
  apiKey?: string;
}

export type ProviderUpsertOutcome =
  | { ok: true; provider: StoredProvider }
  | { ok: false; error: string };

export type ProviderAddOutcome = ProviderUpsertOutcome;

export interface ProviderStore {
  /** 全部服务（含明文 key），仅供 Main 内部使用；给 Renderer 的一律经 toProviderView。 */
  list(): Promise<StoredProvider[]>;
  get(id: string): Promise<StoredProvider | undefined>;
  /** 入参须先经 parseProviderUpsert。无 id 为新建（id 按名称生成），有 id 为整条替换。 */
  upsert(input: ProviderUpsertInput): Promise<ProviderUpsertOutcome>;
  /** id 不存在时返回 false。 */
  remove(id: string): Promise<boolean>;
  /**
   * 批量新建（从本机导入），一次读改写。与已有服务或本批前面的条目地址和 key 都相同的不写入；
   * 名称已被占用（不分大小写）时加「 (2)」「 (3)」…，id 按加了后缀的名称生成。
   * 入参须先经 parseProviderUpsert 且不带 id；结果与入参一一对应。
   */
  addMany(inputs: readonly ProviderUpsertInput[]): Promise<ProviderAddOutcome[]>;
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
        if (!current)
          return {
            result: { ok: false, error: translate('providers.notFoundId', { id: input.id }) },
          };
        const apiKey = input.apiKey === undefined ? current.apiKey : (input.apiKey ?? undefined);
        const provider = buildProvider(current.id, input, apiKey);
        return { next: providers.with(index, provider), result: { ok: true, provider } };
      }),
    remove: (id) =>
      registry.transact((providers) => {
        const next = providers.filter((provider) => provider.id !== id);
        return next.length === providers.length ? { result: false } : { next, result: true };
      }),
    addMany: (inputs) =>
      registry.transact((providers): { next?: StoredProvider[]; result: ProviderAddOutcome[] } => {
        const next = [...providers];
        const names = providers.map((provider) => provider.name);
        const ids = providers.map((provider) => provider.id);
        const owners = new Map(
          providers.map((provider) => [providerFingerprint(provider), provider.name])
        );
        const result = inputs.map((input): ProviderAddOutcome => {
          const fingerprint = providerFingerprint(input);
          const owner = owners.get(fingerprint);
          if (owner !== undefined) {
            return { ok: false, error: translate('providers.sameAs', { owner }) };
          }
          const name = uniqueName(input.name, names);
          const id = uniqueId(toSlug(name, 'provider'), ids);
          const provider = buildProvider(id, { ...input, name }, input.apiKey ?? undefined);
          next.push(provider);
          names.push(name);
          ids.push(id);
          owners.set(fingerprint, name);
          return { ok: true, provider };
        });
        return next.length > providers.length ? { next, result } : { result };
      }),
  };
}

/**
 * 去重键：实际请求地址 + key（与运行时 provider 键同一口径）。末尾 `/`、留空与官方地址算同一个地址。
 * 只在 Main 内存里比较，不落盘、不出进程。
 */
export function providerFingerprint(provider: {
  api: ProviderApi;
  baseUrl?: string;
  apiKey?: string | null;
}): string {
  return `${resolveBaseUrl(provider.api, provider.baseUrl)}\n${provider.apiKey ?? ''}`;
}

/** 名称已被占用（不分大小写）时依次尝试「name (2)」「name (3)」…，截断 name 保证总长不超过上限。 */
function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
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

/** key 的末 4 位，供界面辨认；没有 key 或 key 太短时不给。 */
export function apiKeyHint(apiKey: string | null | undefined): string | undefined {
  return apiKey && apiKey.length >= MIN_KEY_LENGTH_FOR_HINT ? apiKey.slice(-4) : undefined;
}

/** 给 Renderer 的脱敏视图：逐字段构造（不是展开后删除），明文 key 不可能被带出去。 */
export function toProviderView(provider: StoredProvider): ModelProviderView {
  const hint = apiKeyHint(provider.apiKey);
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    enabled: provider.enabled,
    models: provider.models.map((model) => ({ ...model })),
    hasApiKey: Boolean(provider.apiKey),
    ...(hint ? { apiKeyHint: hint } : {}),
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
