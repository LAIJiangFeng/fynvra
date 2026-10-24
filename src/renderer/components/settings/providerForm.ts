import type { CatalogProvider } from '@shared/modelCatalog';
import type { ModelEntry, ModelProviderView, ProviderApi } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';

// 模型服务表单的纯逻辑（不碰 DOM，可在 node 下测试）。

export interface ProviderDraft {
  /** 编辑已有服务时的 id；新建时缺省 */
  id?: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  /** 新输入的 key；编辑时留空表示不修改 */
  apiKey: string;
  /** 编辑时勾选「清除已保存的 key」 */
  clearApiKey: boolean;
  enabled: boolean;
  models: ModelEntry[];
  /** 自定义 OpenAI 兼容服务没有默认地址，必须填写 */
  requiresBaseUrl: boolean;
  hasSavedKey: boolean;
  /** 已保存 key 的末 4 位，只用于提示 */
  savedKeyHint?: string;
}

type FormResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export function draftFromCatalog(entry: CatalogProvider): ProviderDraft {
  return {
    name: entry.name,
    api: entry.api,
    baseUrl: entry.baseUrl ?? '',
    apiKey: '',
    clearApiKey: false,
    enabled: true,
    models: entry.models.map((model) => ({ ...model })),
    requiresBaseUrl: entry.baseUrl === undefined,
    hasSavedKey: false,
  };
}

export function draftFromProvider(provider: ModelProviderView): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl ?? '',
    apiKey: '',
    clearApiKey: false,
    enabled: provider.enabled,
    models: provider.models.map((model) => ({ ...model })),
    requiresBaseUrl: false,
    hasSavedKey: provider.hasApiKey,
    ...(provider.apiKeyHint ? { savedKeyHint: provider.apiKeyHint } : {}),
  };
}

/** 表单 → providers:upsert 入参。key 有输入才提交；编辑时勾选清除则提交 null；Base URL 留空走协议默认地址。 */
export function draftToUpsertInput(
  draft: ProviderDraft
): FormResult<{ input: ProviderUpsertInput }> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: '请填写名称' };
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl && draft.requiresBaseUrl) return { ok: false, error: '请填写 Base URL' };
  if (baseUrl && !isHttpUrl(baseUrl)) {
    return { ok: false, error: 'Base URL 必须以 http:// 或 https:// 开头' };
  }
  const apiKey = draft.apiKey.trim();
  if (/\s/.test(apiKey)) return { ok: false, error: 'API Key 不能包含空白字符' };
  return {
    ok: true,
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      api: draft.api,
      ...(baseUrl ? { baseUrl } : {}),
      enabled: draft.enabled,
      models: draft.models.map((model) => ({ ...model })),
      ...(apiKey ? { apiKey } : draft.clearApiKey ? { apiKey: null } : {}),
    },
  };
}

/** 手动添加模型 id；名称缺省用 id。 */
export function addModel(
  models: readonly ModelEntry[],
  rawId: string
): FormResult<{ models: ModelEntry[] }> {
  const id = rawId.trim();
  if (!id) return { ok: false, error: '请输入模型 id' };
  if (/\s/.test(id)) return { ok: false, error: '模型 id 不能包含空白' };
  if (models.some((model) => model.id === id)) return { ok: false, error: `已经有模型 ${id}` };
  return { ok: true, models: [...models, { id, name: id }] };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
