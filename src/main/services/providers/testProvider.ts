import { asRecord, errorMessage } from '@shared/guards';
import { resolveBaseUrl } from '@shared/modelCatalog';
import type { ProviderApi } from '@shared/types/llm';
import type { ProviderTestResult } from '../../../preload/domains/providers';
import type { StoredProvider } from './providerStore';

/** fetch 的最小子集。Main 传入 Electron 的 net.fetch（走 Chromium 网络栈与系统代理），测试传假实现。 */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
  }
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export interface TestProviderOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export const PROVIDER_TEST_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_DETAIL_LENGTH = 300;

/**
 * 「列模型」请求：不消耗 token，又能同时验证地址与 key。路径与 pi 实际请求的拼法一致
 * （Anthropic SDK 在 baseUrl 后接 /v1，OpenAI 兼容服务的 baseUrl 自带版本段），地址填错在这里就会暴露。
 */
export function buildModelsRequest(
  api: ProviderApi,
  baseUrl: string | undefined,
  apiKey: string
): { url: string; headers: Record<string, string> } {
  const base = resolveBaseUrl(api, baseUrl);
  switch (api) {
    case 'anthropic-messages':
      return {
        url: `${base}/v1/models`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      };
    case 'google-generative-ai':
      // key 放请求头：放在 query 里会出现在错误信息和代理日志中
      return { url: `${base}/models`, headers: { 'x-goog-api-key': apiKey } };
    case 'openai-responses':
    case 'openai-completions':
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
}

/** 用已保存的 key 对服务发一次列模型请求。从不 reject，失败时返回可展示的中文错误（key 已打码）。 */
export async function testProvider(
  provider: StoredProvider,
  { fetch, timeoutMs = PROVIDER_TEST_TIMEOUT_MS, now = Date.now }: TestProviderOptions
): Promise<ProviderTestResult> {
  const { apiKey } = provider;
  if (!apiKey) return { ok: false, error: '还没有填写 API Key' };
  const { url, headers } = buildModelsRequest(provider.api, provider.baseUrl, apiKey);
  const redact = (text: string) => text.split(apiKey).join('***');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
    });
    const body = await response.text();
    const latencyMs = now() - started;
    if (!response.ok) return { ok: false, error: redact(describeHttpError(response.status, body)) };

    const data = asRecord(parseJson(body));
    if (!data) return { ok: false, error: '返回的不是 JSON，请检查 Base URL 是否指向 API 地址' };
    const list = Array.isArray(data.data) ? data.data : data.models;
    return {
      ok: true,
      latencyMs,
      ...(Array.isArray(list) ? { modelCount: list.length } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: `请求超时（${Math.ceil(timeoutMs / 1000)} 秒）：${hostOf(url)}` };
    }
    return { ok: false, error: redact(`无法连接 ${hostOf(url)}：${errorMessage(error)}`) };
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(status: number, body: string): string {
  const detail = serverMessage(body);
  const suffix = detail ? `：${detail}` : '';
  return `${statusHint(status)}（HTTP ${status}）${suffix}`;
}

function statusHint(status: number): string {
  if (status === 401) return 'API Key 无效或已失效';
  if (status === 403) return '没有权限（key 无权访问，或所在地区不受支持）';
  if (status === 404) return '接口不存在，请检查 Base URL';
  if (status === 429) return '请求过多或额度不足';
  if (status >= 500) return '服务端错误，请稍后重试';
  return '请求失败';
}

/** 取服务端错误说明：JSON 的 error.message / error / message，或纯文本；HTML 错误页不回显。 */
function serverMessage(body: string): string {
  const data = asRecord(parseJson(body));
  const error = data?.error;
  const message =
    asRecord(error)?.message ?? (typeof error === 'string' ? error : undefined) ?? data?.message;
  const plain = data || /^\s*</.test(body) ? '' : body;
  const text = typeof message === 'string' ? message : plain;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH)}…` : line;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
