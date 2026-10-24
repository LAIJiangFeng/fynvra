import { type CatalogProvider, MODEL_CATALOG } from '@shared/modelCatalog';
import type { ModelProviderOption } from '@shared/types/chat';
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

/** 打开 / 关闭目录外模型的推理标记；关闭时去掉字段（worker 只认 `reasoning === true`）。 */
export function setModelReasoning(
  models: readonly ModelEntry[],
  id: string,
  on: boolean
): ModelEntry[] {
  return models.map((model) => {
    if (model.id !== id) return model;
    const { reasoning: _omit, ...rest } = model;
    return on ? { ...rest, reasoning: true } : rest;
  });
}

/** sessions:model-options 的回答，连同发请求时的服务列表（档位按其中的 reasoning 标记算出） */
export interface DescribedModels {
  options: readonly ModelProviderOption[];
  providers: readonly ModelProviderView[];
}

/** 模型行的「推理」：由内置目录决定（只读徽标），或由设置里的标记决定（开关） */
export type ReasoningControl = { kind: 'catalog'; reasoning: boolean } | { kind: 'switch' };

/**
 * worker 对 pi 内置目录里有的模型（同协议同 id）只认目录，设置里的 reasoning 标记只对目录外的模型生效。
 * Renderer 不加载 pi，从两处推断「由内置目录决定」：
 * 1. 设置页的模板目录（MODEL_CATALOG，元数据取自 pi 目录）里有同协议同 id 的模型；
 * 2. 已保存的模型：model-options 的档位与算档位时的标记对不上。目录外的模型有档位当且仅当标了推理，
 *    所以没标却有档位、标了却没有档位，只能是目录在决定。
 * 推断不出的按目录外处理，给开关（目录里的非推理模型没标推理时分辨不出来，也给开关，打开不起作用）。
 * `savedProviderId`：编辑已保存的服务时它的 id；表单改了协议、模型是新加的，就没有档位可比。
 */
export function reasoningControl(
  api: ProviderApi,
  modelId: string,
  described: DescribedModels | null,
  savedProviderId: string | undefined
): ReasoningControl {
  const template = MODEL_CATALOG.filter((entry) => entry.api === api)
    .flatMap((entry) => entry.models)
    .find((model) => model.id === modelId);
  const compared = describedModel(described, savedProviderId, api, modelId);
  if (compared && (template || compared.reasoning !== compared.flagged)) {
    return { kind: 'catalog', reasoning: compared.reasoning };
  }
  if (template) return { kind: 'catalog', reasoning: template.reasoning === true };
  return { kind: 'switch' };
}

/** 已保存模型在 model-options 里有没有档位，以及算档位时它标没标推理 */
function describedModel(
  described: DescribedModels | null,
  providerId: string | undefined,
  api: ProviderApi,
  modelId: string
): { reasoning: boolean; flagged: boolean } | undefined {
  if (!described || !providerId) return undefined;
  const provider = described.providers.find((view) => view.id === providerId);
  const entry =
    provider?.api === api ? provider.models.find((model) => model.id === modelId) : undefined;
  const option = described.options
    .find((candidate) => candidate.providerId === providerId)
    ?.models.find((model) => model.id === modelId);
  if (!entry || !option) return undefined;
  return { reasoning: option.thinkingLevels.length > 0, flagged: entry.reasoning === true };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
