import { asRecord } from './guards';
import type { ProviderApi } from './types/llm';

/**
 * 会话级 Fast（优先服务）模式：
 * OpenAI 文档规定 Responses / Chat Completions 的请求可用 `service_tier=fast` 或 `priority`，
 * 响应一律显示实际生效的 `service_tier`。这里统一发 `priority`（OpenAI 兼容实现更常见），
 * 是否真的加速、是否加价由服务商决定。两种 OpenAI 协议之外的模型不发送这个字段。
 */
const FAST_MODE_APIS: Readonly<Record<ProviderApi, boolean>> = {
  'anthropic-messages': false,
  'openai-responses': true,
  'openai-completions': true,
  'google-generative-ai': false,
};

export const FAST_SERVICE_TIER = 'priority';

/** 该协议是否有可靠的 Fast 传参路径（目前是 OpenAI Responses 与 Chat Completions） */
export function supportsFastMode(api: string): boolean {
  return Object.hasOwn(FAST_MODE_APIS, api) && FAST_MODE_APIS[api as ProviderApi];
}

/**
 * 在出站请求体上写入优先服务档位。调用方先确认 enabled 与协议；
 * 只合并普通对象（未知形状原样返回），不删改请求里的其他字段。
 */
export function withFastServiceTier(payload: unknown): unknown {
  const record = asRecord(payload);
  return record ? { ...record, service_tier: FAST_SERVICE_TIER } : payload;
}
