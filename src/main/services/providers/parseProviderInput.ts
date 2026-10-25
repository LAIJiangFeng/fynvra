import { asRecord } from '@shared/guards';
import { isProviderApi } from '@shared/modelCatalog';
import type { ModelEntry } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../preload/domains/providers';
import { translate } from '../../i18n';
import { isRegistryId } from './jsonRegistry';

export type ParseInputResult<T> = { ok: true; input: T } | { ok: false; error: string };

const UPSERT_KEYS = new Set(['id', 'name', 'api', 'baseUrl', 'enabled', 'models', 'apiKey']);
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxOutput', 'reasoning']);
export const MAX_NAME_LENGTH = 80;
export const MAX_URL_LENGTH = 2048;
const MAX_MODELS = 500;
export const MAX_MODEL_ID_LENGTH = 200;
export const MAX_KEY_LENGTH = 4096;

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
  check(record, translate('providers.notObject'));
  const unknownKey = Object.keys(record).find((key) => !UPSERT_KEYS.has(key));
  check(
    unknownKey === undefined,
    translate('providers.unknownField', { field: String(unknownKey) })
  );

  const { id, name, api, enabled } = record;
  check(id === undefined || isRegistryId(id), translate('providers.invalidId'));
  check(typeof name === 'string' && name.trim() !== '', translate('validation.nameEmpty'));
  check(
    name.trim().length <= MAX_NAME_LENGTH,
    translate('validation.nameTooLong', { max: MAX_NAME_LENGTH })
  );
  check(isProviderApi(api), translate('providers.badApi'));
  check(typeof enabled === 'boolean', translate('validation.enabledBoolean'));
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
  check(typeof value === 'string', translate('providers.baseUrlString'));
  const url = value.trim();
  if (url === '') return undefined;
  check(url.length <= MAX_URL_LENGTH && isHttpUrl(url), translate('providers.baseUrlHttp'));
  return url;
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function readApiKey(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  check(typeof value === 'string', translate('providers.apiKeyString'));
  const key = value.trim();
  check(key !== '', translate('providers.apiKeyEmpty'));
  check(key.length <= MAX_KEY_LENGTH && !/\s/.test(key), translate('providers.apiKeyWhitespace'));
  return key;
}

function readModels(value: unknown): ModelEntry[] {
  check(Array.isArray(value), translate('providers.modelsArray'));
  check(value.length <= MAX_MODELS, translate('providers.modelsTooMany', { max: MAX_MODELS }));
  const seen = new Set<string>();
  return value.map((item) => {
    const model = readModel(item);
    check(!seen.has(model.id), translate('providers.modelDuplicate', { id: model.id }));
    seen.add(model.id);
    return model;
  });
}

function readModel(raw: unknown): ModelEntry {
  const record = asRecord(raw);
  check(record, translate('providers.modelObject'));
  const unknownKey = Object.keys(record).find((key) => !MODEL_KEYS.has(key));
  check(
    unknownKey === undefined,
    translate('providers.modelUnknownField', { field: String(unknownKey) })
  );
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  check(
    id !== '' && id.length <= MAX_MODEL_ID_LENGTH && !/\s/.test(id),
    translate('providers.modelId')
  );
  const { name, reasoning } = record;
  check(
    name === undefined || name === null || typeof name === 'string',
    translate('providers.modelName', { id })
  );
  check(
    reasoning === undefined || typeof reasoning === 'boolean',
    translate('providers.modelReasoning', { id })
  );
  const contextWindow = readPositiveInt(
    record.contextWindow,
    translate('providers.modelContext', { id })
  );
  const maxOutput = readPositiveInt(
    record.maxOutput,
    translate('providers.modelMaxOutput', { id })
  );
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
