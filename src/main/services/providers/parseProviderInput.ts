import { asRecord } from '@shared/guards';
import { isProviderApi } from '@shared/modelCatalog';
import type { ModelEntry } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';
import { isRegistryId } from './jsonRegistry';

export type ParseInputResult<T> = { ok: true; input: T } | { ok: false; error: string };

const UPSERT_KEYS = new Set(['id', 'name', 'api', 'baseUrl', 'enabled', 'models', 'apiKey']);
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxOutput', 'reasoning']);
export const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const MAX_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_KEY_LENGTH = 4096;

class InputError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InputError(message);
}

/**
 * `providers:upsert` 入参收窄（严格）：未知字段、类型不符一律拒绝，整个请求作废。
 * 文本字段去首尾空白；apiKey 缺省表示保留已保存的 key，`null` 表示清除。
 */
export function parseProviderUpsert(raw: unknown): ParseInputResult<ProviderUpsertInput> {
  try {
    return { ok: true, input: readUpsert(raw) };
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: error.message };
    throw error;
  }
}

function readUpsert(raw: unknown): ProviderUpsertInput {
  const record = asRecord(raw);
  check(record, '无效的模型服务：需要一个对象');
  const unknownKey = Object.keys(record).find((key) => !UPSERT_KEYS.has(key));
  check(unknownKey === undefined, `无效的模型服务：未知字段 ${unknownKey}`);

  const { id, name, api, enabled } = record;
  check(id === undefined || isRegistryId(id), '无效的模型服务 id');
  check(typeof name === 'string' && name.trim() !== '', '名称不能为空');
  check(name.trim().length <= MAX_NAME_LENGTH, `名称最多 ${MAX_NAME_LENGTH} 个字符`);
  check(isProviderApi(api), '不支持的 API 协议');
  check(typeof enabled === 'boolean', 'enabled 必须是布尔值');
  const baseUrl = readBaseUrl(record.baseUrl);
  const apiKey = readApiKey(record.apiKey);

  return {
    ...(id === undefined ? {} : { id }),
    name: name.trim(),
    api,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled,
    models: readModels(record.models),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

function readBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  check(typeof value === 'string', 'Base URL 必须是字符串');
  const url = value.trim();
  if (url === '') return undefined;
  check(url.length <= MAX_URL_LENGTH && isHttpUrl(url), 'Base URL 必须是 http(s) 地址');
  return url;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function readApiKey(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  check(typeof value === 'string', 'API Key 必须是字符串');
  const key = value.trim();
  check(key !== '', 'API Key 不能为空；不修改请不传该字段');
  check(key.length <= MAX_KEY_LENGTH && !/\s/.test(key), 'API Key 不能包含空白字符');
  return key;
}

function readModels(value: unknown): ModelEntry[] {
  check(Array.isArray(value), '模型列表必须是数组');
  check(value.length <= MAX_MODELS, `模型最多 ${MAX_MODELS} 个`);
  const seen = new Set<string>();
  return value.map((item) => {
    const model = readModel(item);
    check(!seen.has(model.id), `模型 ${model.id} 重复`);
    seen.add(model.id);
    return model;
  });
}

function readModel(raw: unknown): ModelEntry {
  const record = asRecord(raw);
  check(record, '模型必须是对象');
  const unknownKey = Object.keys(record).find((key) => !MODEL_KEYS.has(key));
  check(unknownKey === undefined, `模型含未知字段 ${unknownKey}`);
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  check(
    id !== '' && id.length <= MAX_MODEL_ID_LENGTH && !/\s/.test(id),
    '模型 id 不能为空或含空白'
  );
  const { name, reasoning } = record;
  check(name === undefined || name === null || typeof name === 'string', `模型 ${id} 的名称无效`);
  check(reasoning === undefined || typeof reasoning === 'boolean', `模型 ${id} 的 reasoning 无效`);
  const contextWindow = readPositiveInt(record.contextWindow, `模型 ${id} 的上下文窗口无效`);
  const maxOutput = readPositiveInt(record.maxOutput, `模型 ${id} 的最大输出无效`);
  return {
    id,
    name: (typeof name === 'string' && name.trim()) || id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function readPositiveInt(value: unknown, message: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  check(Number.isSafeInteger(value) && (value as number) > 0, message);
  return value as number;
}
