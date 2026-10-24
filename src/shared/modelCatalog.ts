import type { ModelEntry, ProviderApi } from './types/llm';

// Record 键强制穷举 ProviderApi：§9.6 加了协议而这里没加会编译失败。
const PROVIDER_API_LABELS: Readonly<Record<ProviderApi, string>> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-completions': 'OpenAI Chat Completions',
  'google-generative-ai': 'Google Generative AI',
};

/** 全部模型协议，按 §9.6 声明顺序。 */
export const PROVIDER_APIS = Object.freeze(Object.keys(PROVIDER_API_LABELS) as ProviderApi[]);

export function isProviderApi(value: unknown): value is ProviderApi {
  return typeof value === 'string' && Object.hasOwn(PROVIDER_API_LABELS, value);
}

export function providerApiLabel(api: ProviderApi): string {
  return PROVIDER_API_LABELS[api];
}

/**
 * 各协议未填写 Base URL 时的官方地址。Google 带版本段：pi 的 Google SDK 在指定 baseUrl 时不再自动补版本，
 * 少了 `/v1beta` 会 404。
 */
export const DEFAULT_BASE_URLS: Readonly<Record<ProviderApi, string>> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-completions': 'https://api.openai.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

const VERSION_SEGMENT = /\/v\d+(?:alpha|beta)?$/;

/** 实际请求地址：去掉首尾空白与末尾 `/`，留空时用协议默认地址；Google 地址缺版本段时补 `/v1beta`。 */
export function resolveBaseUrl(api: ProviderApi, baseUrl?: string): string {
  const base = baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URLS[api];
  if (api === 'google-generative-ai' && !VERSION_SEGMENT.test(base)) return `${base}/v1beta`;
  return base;
}

export type CatalogProviderId = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

/** 新建模型服务时的模板：协议、官方地址与预置模型，用户保存前可改。 */
export interface CatalogProvider {
  id: CatalogProviderId;
  name: string;
  api: ProviderApi;
  /** 官方地址；自定义 OpenAI 兼容服务没有默认值，必须填写。 */
  baseUrl?: string;
  models: readonly ModelEntry[];
}

// 模型元数据（上下文窗口、最大输出、是否推理）取自 @earendil-works/pi-ai 1.4.0 的内置模型目录。
const claude = (id: string, name: string): ModelEntry => ({
  id,
  name,
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  reasoning: true,
});
const gpt = (id: string, name: string): ModelEntry => ({
  id,
  name,
  contextWindow: 272_000,
  maxOutput: 128_000,
  reasoning: true,
});
const gemini = (id: string, name: string, maxOutput: number): ModelEntry => ({
  id,
  name,
  contextWindow: 1_048_576,
  maxOutput,
  reasoning: true,
});

export const MODEL_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: DEFAULT_BASE_URLS['anthropic-messages'],
    models: [
      claude('claude-fable-5-1', 'Claude Fable 5.1'),
      claude('claude-opus-5-5', 'Claude Opus 5.5'),
      claude('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
      claude('claude-haiku-5-5', 'Claude Haiku 5.5'),
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-responses',
    baseUrl: DEFAULT_BASE_URLS['openai-responses'],
    models: [
      gpt('gpt-6.1-sol', 'GPT-6.1 Sol'),
      gpt('gpt-6-sol', 'GPT-6 Sol'),
      gpt('gpt-6-luna', 'GPT-6 Luna'),
      gpt('gpt-5.5', 'GPT-5.5'),
    ],
  },
  {
    id: 'google',
    name: 'Google',
    api: 'google-generative-ai',
    baseUrl: DEFAULT_BASE_URLS['google-generative-ai'],
    models: [
      gemini('gemini-4-argon', 'Gemini 4 Argon', 32_768),
      gemini('gemini-pro-latest', 'Gemini Pro Latest', 65_536),
      gemini('gemini-flash-latest', 'Gemini Flash Latest', 65_536),
    ],
  },
  {
    id: 'openai-compatible',
    name: '自定义 OpenAI 兼容',
    api: 'openai-completions',
    models: [],
  },
];

export function findCatalogProvider(id: string): CatalogProvider | undefined {
  return MODEL_CATALOG.find((provider) => provider.id === id);
}
