import { asRecord } from '@shared/guards';
import { isProviderApi } from '@shared/modelCatalog';
import type { ListRemoteModelsInput } from '../../../../preload/domains/providers';
import { isRegistryId } from '../jsonRegistry';
import {
  isHttpUrl,
  MAX_KEY_LENGTH,
  MAX_URL_LENGTH,
  type ParseInputResult,
} from '../parseProviderInput';
import type { StoredProvider } from '../providerStore';
import type { RemoteModelsTarget } from './listRemoteModels';

type RemoteModelsDraft = NonNullable<ListRemoteModelsInput['draft']>;

const INPUT_KEYS = new Set(['providerId', 'draft']);
const DRAFT_KEYS = new Set(['api', 'baseUrl', 'apiKey']);
const MISSING_SOURCE = '需要模型服务 id，或表单里的协议与地址';

/**
 * `providers:list-remote-models` 入参收窄（严格）：未知字段、类型不符一律拒绝；providerId 与 draft 至少一个。
 * draft 的地址与 key 按 providers:upsert 的规则：去首尾空白，空地址视为没填（用协议的官方地址），key 不能含空白。
 */
export function parseListRemoteModelsInput(raw: unknown): ParseInputResult<ListRemoteModelsInput> {
  const record = asRecord(raw);
  if (!record) return invalid('无效的参数：需要一个对象');
  const unknownKey = Object.keys(record).find((key) => !INPUT_KEYS.has(key));
  if (unknownKey !== undefined) return invalid(`无效的参数：未知字段 ${unknownKey}`);
  const { providerId } = record;
  if (providerId !== undefined && !isRegistryId(providerId)) return invalid('无效的模型服务 id');
  if (record.draft === undefined) {
    return providerId === undefined ? invalid(MISSING_SOURCE) : { ok: true, input: { providerId } };
  }
  const draft = readDraft(record.draft);
  if (!draft.ok) return draft;
  return {
    ok: true,
    input: { ...(providerId === undefined ? {} : { providerId }), draft: draft.input },
  };
}

function readDraft(raw: unknown): ParseInputResult<RemoteModelsDraft> {
  const record = asRecord(raw);
  if (!record) return invalid('无效的服务表单：需要一个对象');
  const unknownKey = Object.keys(record).find((key) => !DRAFT_KEYS.has(key));
  if (unknownKey !== undefined) return invalid(`无效的服务表单：未知字段 ${unknownKey}`);
  const { api, baseUrl, apiKey } = record;
  if (!isProviderApi(api)) return invalid('不支持的 API 协议');

  let url: string | undefined;
  if (baseUrl !== undefined && baseUrl !== null) {
    if (typeof baseUrl !== 'string') return invalid('Base URL 必须是字符串');
    url = baseUrl.trim() || undefined;
    if (url && (url.length > MAX_URL_LENGTH || !isHttpUrl(url))) {
      return invalid('Base URL 必须是 http(s) 地址');
    }
  }
  let key: string | undefined;
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== 'string') return invalid('API Key 必须是字符串');
    key = apiKey.trim();
    if (!key) return invalid('API Key 不能为空；用已保存的 key 请不传该字段');
    if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) return invalid('API Key 不能包含空白字符');
  }
  return {
    ok: true,
    input: { api, ...(url ? { baseUrl: url } : {}), ...(key ? { apiKey: key } : {}) },
  };
}

/**
 * 定下要请求的服务：协议与地址以 draft 为准（draft 没写地址就是协议的官方地址，与按表单保存后一致），
 * key 以 draft 优先、没带就用已保存的；alreadyAdded 对照已保存的模型列表。
 * `stored` 是按 input.providerId 从 providers.json 读到的记录，没传 providerId 时为 undefined。
 */
export function remoteModelsTarget(
  input: ListRemoteModelsInput,
  stored: StoredProvider | undefined
): { ok: true; target: RemoteModelsTarget } | { ok: false; error: string } {
  if (input.providerId !== undefined && !stored) return invalid('模型服务不存在');
  const source = input.draft ?? stored;
  if (!source) return invalid(MISSING_SOURCE);
  const apiKey = input.draft?.apiKey ?? stored?.apiKey;
  if (!apiKey) return invalid('还没有填写 API Key');
  return {
    ok: true,
    target: {
      api: source.api,
      ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
      apiKey,
      savedModelIds: stored?.models.map((model) => model.id) ?? [],
    },
  };
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
