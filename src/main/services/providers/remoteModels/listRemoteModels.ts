import { errorMessage } from '@shared/guards';
import { MODEL_CATALOG, resolveBaseUrl } from '@shared/modelCatalog';
import type { ModelEntry, ProviderApi, RemoteModelEntry } from '@shared/types/llm';
import type { ListRemoteModelsResult } from '../../../../preload/domains/providers';
import { MAX_MODEL_ID_LENGTH } from '../parseProviderInput';
import {
  buildModelsRequest,
  describeHttpError,
  type FetchLike,
  hostOf,
  PROVIDER_TEST_TIMEOUT_MS,
  parseJson,
  serverMessage,
} from '../testProvider';
import {
  type ParsedModelList,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAiModels,
} from './parsers';

/** 要列模型的服务：协议、地址与 key 已按「表单优先、已保存兜底」定好（见 remoteModelsTarget）。 */
export interface RemoteModelsTarget {
  api: ProviderApi;
  /** 缺省为协议的官方地址 */
  baseUrl?: string;
  apiKey: string;
  /** 已保存服务里的模型 id，用于标 alreadyAdded */
  savedModelIds: readonly string[];
}

export interface ListRemoteModelsOptions {
  /** Main 传入 Electron 的 net.fetch（与 providers:test 相同），测试传假实现 */
  fetch: FetchLike;
  /** 每次请求的超时，默认 15 秒 */
  timeoutMs?: number;
}

type ListShape = 'anthropic' | 'openai' | 'google';

/** 一次「列模型」请求：前一种失败在 retryOn 里（或返回的不是列表）时，换下一种再试。 */
export interface ModelsRequest {
  url: string;
  headers: Record<string, string>;
  /** 按哪种形态解析返回 */
  shape: ListShape;
  /** 这些 HTTP 状态不是终局：后面还有请求就换下一种 */
  retryOn: readonly number[];
  /** 改用了哪种请求时写进提示 */
  via: string;
}

/** 列表最多给 Renderer 这么多条，挡住异常巨大的返回 */
export const MAX_REMOTE_MODELS = 2000;
const ANTHROPIC_PAGE_LIMIT = 1000;
const GOOGLE_PAGE_SIZE = 1000;
/** 与 modelCatalog.resolveBaseUrl 判断 Google 版本段的规则相同 */
const VERSION_SEGMENT = /\/v\d+(?:alpha|beta)?$/;
const NOT_A_MODEL_LIST = '接口返回的不是模型列表';

const PARSERS: Readonly<Record<ListShape, (body: unknown) => ParsedModelList | null>> = {
  anthropic: parseAnthropicModels,
  openai: parseOpenAiModels,
  google: parseGoogleModels,
};

/**
 * 各协议依次尝试的请求。地址与头沿用 providers:test 的 buildModelsRequest（与 pi 实际请求的拼法一致）：
 * - Anthropic：`<base>/v1/models` + x-api-key；很多中转只实现了 OpenAI 形态，被拒（400 / 401 / 403 / 404 / 405）
 *   或返回的不是列表时，改用同一地址 + Bearer；
 * - OpenAI 兼容：地址已以版本段结尾（`/v1`、`/v4`…）时 `<base>/models`，否则先 `<base>/v1/models`，
 *   404 / 405 或不是列表再试 pi 实际用的 `<base>/models`；
 * - Google：`<base>/v1beta/models`，key 放请求头（不进 URL，不会出现在错误信息与代理日志里）。
 */
export function remoteModelsRequests(
  api: ProviderApi,
  baseUrl: string | undefined,
  apiKey: string
): ModelsRequest[] {
  const bearer = { Authorization: `Bearer ${apiKey}` };
  switch (api) {
    case 'anthropic-messages': {
      const { url, headers } = buildModelsRequest(api, baseUrl, apiKey);
      return [
        {
          url: `${url}?limit=${ANTHROPIC_PAGE_LIMIT}`,
          headers,
          shape: 'anthropic',
          retryOn: [400, 401, 403, 404, 405],
          via: 'Anthropic 形态（x-api-key）',
        },
        {
          url,
          headers: bearer,
          shape: 'openai',
          retryOn: [],
          via: 'OpenAI 形态（Authorization: Bearer）',
        },
      ];
    }
    case 'openai-responses':
    case 'openai-completions': {
      const { url, headers } = buildModelsRequest(api, baseUrl, apiKey);
      const base = resolveBaseUrl(api, baseUrl);
      const direct: ModelsRequest = { url, headers, shape: 'openai', retryOn: [], via: url };
      if (VERSION_SEGMENT.test(base)) return [direct];
      const versioned = `${base}/v1/models`;
      return [{ ...direct, url: versioned, retryOn: [404, 405], via: versioned }, direct];
    }
    case 'google-generative-ai': {
      const { url, headers } = buildModelsRequest(api, baseUrl, apiKey);
      return [
        {
          url: `${url}?pageSize=${GOOGLE_PAGE_SIZE}`,
          headers,
          shape: 'google',
          retryOn: [],
          via: url,
        },
      ];
    }
  }
}

type Outcome =
  | { kind: 'list'; list: ParsedModelList }
  /** 超时、连不上：换一种请求也没用 */
  | { kind: 'fatal'; error: string }
  | { kind: 'http'; status: number; error: string }
  /** 2xx，但不是 JSON 或不是这种形态的列表 */
  | { kind: 'not-list'; error: string };
type Failure = Extract<Outcome, { kind: 'http' | 'not-list' }>;

/**
 * 拉取服务端的模型列表。从不 reject：失败时返回可读的中文错误。返回值（模型、地址、提示、错误）里的 key 都被去掉，
 * 含 key 的模型 id 直接丢弃，含 key 的显示名换成目录名或 id。
 */
export async function listRemoteModels(
  target: RemoteModelsTarget,
  { fetch, timeoutMs = PROVIDER_TEST_TIMEOUT_MS }: ListRemoteModelsOptions
): Promise<ListRemoteModelsResult> {
  const { apiKey } = target;
  if (!apiKey) return { ok: false, error: '还没有填写 API Key' };
  const redact = (text: string) => text.split(apiKey).join('***');
  const requests = remoteModelsRequests(target.api, target.baseUrl, apiKey);
  const failures: Array<{ request: ModelsRequest; failure: Failure }> = [];

  for (const [index, request] of requests.entries()) {
    const outcome = await send(request, fetch, timeoutMs);
    if (outcome.kind === 'list') {
      const { models, notes } = toEntries(outcome.list, target);
      const fallbacks = failures.map(
        (previous) =>
          `${spaced(previous.request.via)}不可用（${reasonOf(previous.failure)}），已改用 ${request.via}`
      );
      return {
        ok: true,
        models,
        endpoint: redact(endpointOf(request.url)),
        warnings: [...fallbacks, ...notes].map(redact),
      };
    }
    if (outcome.kind === 'fatal') return { ok: false, error: redact(outcome.error) };
    const last = index === requests.length - 1;
    if (!last && outcome.kind === 'http' && !request.retryOn.includes(outcome.status)) {
      return { ok: false, error: redact(outcome.error) };
    }
    failures.push({ request, failure: outcome });
  }
  return { ok: false, error: redact(mostTelling(failures.map((entry) => entry.failure))) };
}

async function send(request: ModelsRequest, fetch: FetchLike, timeoutMs: number): Promise<Outcome> {
  const endpoint = endpointOf(request.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: controller.signal,
      redirect: 'error',
    });
    const body = await response.text();
    if (!response.ok) {
      const error = `${describeHttpError(response.status, body)} · ${endpoint}`;
      return { kind: 'http', status: response.status, error };
    }
    const list = PARSERS[request.shape](parseJson(body));
    if (list) return { kind: 'list', list };
    const detail = serverMessage(body);
    return {
      kind: 'not-list',
      error: `${NOT_A_MODEL_LIST}${detail ? `：${detail}` : ''} · ${endpoint}`,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        kind: 'fatal',
        error: `请求超时（${Math.ceil(timeoutMs / 1000)} 秒）：${hostOf(request.url)}`,
      };
    }
    return { kind: 'fatal', error: `无法连接 ${hostOf(request.url)}：${networkReason(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析结果 → 视图：校验 id、去重、补内置目录的元数据、标已添加、排序、截断，附带要提示的数量。 */
function toEntries(
  list: ParsedModelList,
  target: RemoteModelsTarget
): { models: RemoteModelEntry[]; notes: string[] } {
  const catalog = catalogModels(target.api);
  const saved = new Set(target.savedModelIds);
  const seen = new Set<string>();
  const models: RemoteModelEntry[] = [];
  let invalid = list.invalid;
  for (const parsed of list.models) {
    const id = parsed.id.trim();
    if (!isModelId(id) || id.includes(target.apiKey)) {
      invalid += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const known = catalog.get(id);
    const served = parsed.name && !parsed.name.includes(target.apiKey) ? parsed.name : undefined;
    const contextWindow = parsed.contextWindow ?? known?.contextWindow;
    const maxOutput = parsed.maxOutput ?? known?.maxOutput;
    models.push({
      id,
      name: served ?? known?.name ?? id,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(known?.reasoning !== undefined ? { reasoning: known.reasoning } : {}),
      alreadyAdded: saved.has(id),
    });
  }
  models.sort((a, b) => collator.compare(a.id, b.id));

  const notes: string[] = [];
  if (invalid > 0) notes.push(`${invalid} 个条目没有有效的模型 id，已跳过`);
  if (list.filtered > 0) {
    notes.push(`已略过 ${list.filtered} 个不支持 generateContent 的模型（如嵌入、图像模型）`);
  }
  if (list.more) notes.push('服务端还有更多模型没有返回，这里只列出了第一页');
  if (models.length > MAX_REMOTE_MODELS) notes.push(`模型太多，只列出前 ${MAX_REMOTE_MODELS} 个`);
  return { models: models.slice(0, MAX_REMOTE_MODELS), notes };
}

/** 按 id 的自然顺序（m-9 在 m-10 前），不随系统语言变 */
const collator = new Intl.Collator('en', { numeric: true });

/**
 * reasoning 等元数据的来源：设置页的内置目录（MODEL_CATALOG，取自 pi 的内置模型目录），按同协议同 id 查，
 * 与 worker 认模板、服务弹窗认「由内置目录决定」的口径相同。Main 不加载 pi，目录里没有的模型就不带。
 */
function catalogModels(api: ProviderApi): Map<string, ModelEntry> {
  return new Map(
    MODEL_CATALOG.filter((provider) => provider.api === api)
      .flatMap((provider) => provider.models)
      .map((model) => [model.id, model])
  );
}

/** 与 parseProviderUpsert 的模型 id 规则一致：列出来的都能随服务保存 */
function isModelId(id: string): boolean {
  return id !== '' && id.length <= MAX_MODEL_ID_LENGTH && !/\s/.test(id);
}

/** 都失败时报最能说明问题的：key 被拒 > 其他 HTTP 错误 > 不是列表 > 接口不存在；同级取先请求的。 */
function mostTelling(failures: readonly Failure[]): string {
  const rank = (failure: Failure) => {
    if (failure.kind === 'not-list') return 1;
    if (failure.status === 401 || failure.status === 403) return 3;
    return failure.status === 404 || failure.status === 405 ? 0 : 2;
  };
  const best = failures.reduce((current, next) => (rank(next) > rank(current) ? next : current));
  return best.error;
}

function reasonOf(failure: Failure): string {
  return failure.kind === 'http' ? `HTTP ${failure.status}` : '返回的不是模型列表';
}

/** 地址后面接中文要隔一个空格，全角括号结尾的不用 */
function spaced(label: string): string {
  return /[!-~]$/.test(label) ? `${label} ` : label;
}

/** 展示用地址：去掉 query（分页参数） */
function endpointOf(url: string): string {
  return url.split('?')[0] ?? url;
}

/** Node 的 fetch 把真正的原因放在 cause 里（如 ECONNREFUSED） */
function networkReason(error: unknown): string {
  const reason = errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? `${reason}（${cause.message}）` : reason;
}
