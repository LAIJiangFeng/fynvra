import type { ModelEntry, RemoteModelEntry } from '@shared/types/llm';
import type { ListRemoteModelsInput } from '../../../preload/domains/providers';
import type { ProviderDraft } from './providerForm';

// 服务弹窗「拉取模型列表」的纯逻辑（不碰 DOM 与 window.fynvra，在 node 下测试）。

/** 一个服务最多这么多模型：与 Main 的 providers:upsert 校验（parseProviderInput 的 MAX_MODELS）一致 */
export const MAX_PROVIDER_MODELS = 500;

export type RemoteModelsRequest =
  | { ok: true; input: ListRemoteModelsInput }
  | { ok: false; error: string };

/** 按钮能不能点：有地址就行（填了，或协议有官方地址；自定义 OpenAI 兼容服务没有默认地址） */
export function canListRemoteModels(draft: ProviderDraft): boolean {
  return draft.baseUrl.trim() !== '' || !draft.requiresBaseUrl;
}

/**
 * 表单 → providers:list-remote-models 入参。协议与地址总按表单当前的内容（可能还没保存）；
 * 已保存的服务带上 id，没填新 key 时 Main 用已保存的 key。没有 key 可用时只给提示，不发请求。
 */
export function remoteModelsRequest(draft: ProviderDraft): RemoteModelsRequest {
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl && draft.requiresBaseUrl) return { ok: false, error: '先填写 Base URL' };
  if (baseUrl && !isHttpUrl(baseUrl)) {
    return { ok: false, error: 'Base URL 必须以 http:// 或 https:// 开头' };
  }
  const apiKey = draft.apiKey.trim();
  if (/\s/.test(apiKey)) return { ok: false, error: 'API Key 不能包含空白字符' };
  const savedKey = draft.id !== undefined && draft.hasSavedKey && !draft.clearApiKey;
  if (!apiKey && !savedKey) return { ok: false, error: '先填写 API Key，再拉取模型列表' };
  return {
    ok: true,
    input: {
      ...(draft.id ? { providerId: draft.id } : {}),
      draft: { api: draft.api, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) },
    },
  };
}

/** 「已添加」以表单当前的模型列表为准（Main 的 alreadyAdded 只对照已保存的列表） */
export function markAdded(
  models: readonly RemoteModelEntry[],
  current: readonly ModelEntry[]
): RemoteModelEntry[] {
  const ids = new Set(current.map((model) => model.id));
  return models.map((model) =>
    model.alreadyAdded === ids.has(model.id) ? model : { ...model, alreadyAdded: ids.has(model.id) }
  );
}

/** 搜索：不分大小写、按空白分词，每个词都要出现在 id 或名称里 */
export function filterRemoteModels(
  models: readonly RemoteModelEntry[],
  query: string
): RemoteModelEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...models];
  return models.filter((model) => {
    const text = `${model.id} ${model.name}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function toggleSelected(selected: readonly string[], id: string, on: boolean): string[] {
  const rest = selected.filter((entry) => entry !== id);
  return on ? [...rest, id] : rest;
}

/** 当前视图里还能勾选的（没添加过的） */
const selectableIds = (visible: readonly RemoteModelEntry[]) =>
  visible.filter((model) => !model.alreadyAdded).map((model) => model.id);

/** 全选当前视图；搜索前已勾选、现在不在视图里的保留 */
export function selectAllVisible(
  selected: readonly string[],
  visible: readonly RemoteModelEntry[]
): string[] {
  return [...new Set([...selected, ...selectableIds(visible)])];
}

/** 反选当前视图；视图外的勾选不动 */
export function invertVisible(
  selected: readonly string[],
  visible: readonly RemoteModelEntry[]
): string[] {
  const next = new Set(selected);
  for (const id of selectableIds(visible)) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return [...next];
}

/** 要加入的：勾选里还没添加的，按列表顺序 */
export function pickedModels(
  models: readonly RemoteModelEntry[],
  selected: readonly string[]
): RemoteModelEntry[] {
  const ids = new Set(selected);
  return models.filter((model) => ids.has(model.id) && !model.alreadyAdded);
}

export interface MergeResult {
  models: ModelEntry[];
  added: number;
  /** 已在列表里而跳过的 */
  existing: number;
  /** 超出每个服务的模型上限而没加的 */
  overLimit: number;
}

/**
 * 合并进表单的模型列表：已有的条目原样保留（用户改过的名称、推理标记都不动），新条目接在后面，
 * 带上服务端 / 内置目录给的元数据；推理只带 `true`（worker 只认 `reasoning === true`）。
 */
export function mergeRemoteModels(
  current: readonly ModelEntry[],
  picked: readonly RemoteModelEntry[],
  limit = MAX_PROVIDER_MODELS
): MergeResult {
  const models = [...current];
  const ids = new Set(current.map((model) => model.id));
  let added = 0;
  let existing = 0;
  let overLimit = 0;
  for (const entry of picked) {
    if (ids.has(entry.id)) {
      existing += 1;
      continue;
    }
    if (models.length >= limit) {
      overLimit += 1;
      continue;
    }
    models.push({
      id: entry.id,
      name: entry.name || entry.id,
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxOutput ? { maxOutput: entry.maxOutput } : {}),
      ...(entry.reasoning === true ? { reasoning: true } : {}),
    });
    ids.add(entry.id);
    added += 1;
  }
  return { models, added, existing, overLimit };
}

export function mergeSummary({ added, existing, overLimit }: MergeResult): string {
  const parts = [added > 0 ? `已加入 ${added} 个模型，保存后生效` : '没有加入新模型'];
  if (existing > 0) parts.push(`${existing} 个已在列表里`);
  if (overLimit > 0) {
    parts.push(`每个服务最多 ${MAX_PROVIDER_MODELS} 个模型，${overLimit} 个没有加入`);
  }
  return parts.join('；');
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
