import { asRecord } from '@shared/guards';

// 三种协议「列模型」接口的返回 → 模型条目。纯函数：入参是 JSON.parse 的结果（解析失败时是 undefined）；
// 结构不对返回 null，由调用方决定换一种请求再试还是报「接口返回的不是模型列表」。

/** 解析出的一个模型。id 只保证是字符串，去空白、校验与去重在 listRemoteModels 里做。 */
export interface ParsedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface ParsedModelList {
  models: ParsedModel[];
  /** 没有字符串 id 的条目数 */
  invalid: number;
  /** 按协议规则略过的条目数（Google：不支持 generateContent 的嵌入、图像模型等） */
  filtered: number;
  /** 服务端表示还有下一页（Anthropic 的 has_more、Google 的 nextPageToken） */
  more: boolean;
}

/** Anthropic `GET /v1/models`：`{ data: [{ id, display_name, created_at, type }], has_more }`。 */
export function parseAnthropicModels(body: unknown): ParsedModelList | null {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.data)) return null;
  const list = collect(record.data, (item) => ({ id: item.id, name: item.display_name }));
  return list && { ...list, more: record.has_more === true };
}

/** OpenAI 兼容 `GET /models`：`{ object: 'list', data: [{ id, object, created, owned_by }] }`，没有显示名。 */
export function parseOpenAiModels(body: unknown): ParsedModelList | null {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.data)) return null;
  const list = collect(record.data, (item) => ({ id: item.id }));
  return list && { ...list, more: false };
}

/**
 * Google `GET /v1beta/models`：`{ models: [{ name: 'models/…', displayName, inputTokenLimit, outputTokenLimit,
 * supportedGenerationMethods }], nextPageToken }`。只留支持 generateContent 的；没写支持哪些方法的（部分中转）保留。
 */
export function parseGoogleModels(body: unknown): ParsedModelList | null {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.models)) return null;
  const generative = record.models.filter((raw) => {
    const methods = asRecord(raw)?.supportedGenerationMethods;
    return !Array.isArray(methods) || methods.includes('generateContent');
  });
  const list = collect(generative, (item) => ({
    id: typeof item.name === 'string' ? item.name.replace(/^models\//, '') : item.name,
    name: item.displayName,
    contextWindow: item.inputTokenLimit,
    maxOutput: item.outputTokenLimit,
  }));
  if (!list) return null;
  const more = typeof record.nextPageToken === 'string' && record.nextPageToken !== '';
  return { ...list, filtered: record.models.length - generative.length, more };
}

interface Picked {
  id: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxOutput?: unknown;
}

/** 逐条取字段；有条目却一条都认不出来，说明不是这种形态的列表，返回 null。 */
function collect(
  items: readonly unknown[],
  pick: (item: Record<string, unknown>) => Picked
): Omit<ParsedModelList, 'more'> | null {
  const models: ParsedModel[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    const picked = item && pick(item);
    if (!picked || typeof picked.id !== 'string') continue;
    const name = typeof picked.name === 'string' ? picked.name.trim() : '';
    models.push({
      id: picked.id,
      ...(name ? { name } : {}),
      ...(isPositiveInt(picked.contextWindow) ? { contextWindow: picked.contextWindow } : {}),
      ...(isPositiveInt(picked.maxOutput) ? { maxOutput: picked.maxOutput } : {}),
    });
  }
  if (items.length > 0 && models.length === 0) return null;
  return { models, invalid: items.length - models.length, filtered: 0 };
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
