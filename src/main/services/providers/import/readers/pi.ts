import { asRecord } from '@shared/guards';
import { isProviderApi } from '@shared/modelCatalog';
import type { ModelEntry, ProviderApi } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import {
  baseUrlOf,
  type DiscoveredProvider,
  type Env,
  modelEntries,
  parseJsonObject,
  type ReaderResult,
  text,
} from './common';

const MODELS_FILE = 'models.json';
const AUTH_FILE = 'auth.json';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

type KeyResult =
  | { kind: 'none' }
  | { kind: 'value'; value: string }
  | { kind: 'command' }
  | { kind: 'missing-env'; names: string[] };

/**
 * pi 的 key 写法（与 pi 的 resolve-config-value 一致）：`!` 开头是命令；否则按模板展开，
 * `$NAME` / `${NAME}` 取环境变量，`$$` / `$!` 转义成字面的 `$` / `!`。命令绝不执行。
 */
export function resolvePiKey(raw: unknown, env: Env): KeyResult {
  const config = text(raw);
  if (!config) return { kind: 'none' };
  if (config.startsWith('!')) return { kind: 'command' };

  let value = '';
  const missing: string[] = [];
  const resolveEnv = (name: string) => {
    const found = env[name];
    if (found) value += found;
    else if (!missing.includes(name)) missing.push(name);
  };
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      value += config.slice(index);
      break;
    }
    value += config.slice(index, dollar);
    const next = config[dollar + 1];
    if (next === '$' || next === '!') {
      value += next;
      index = dollar + 2;
      continue;
    }
    if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        value += '$';
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_NAME.test(name)) resolveEnv(name);
      else value += config.slice(dollar, end + 1);
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_NAME_PREFIX);
    if (match) {
      resolveEnv(match[0]);
      index = dollar + 1 + match[0].length;
      continue;
    }
    value += '$';
    index = dollar + 1;
  }
  if (missing.length > 0) return { kind: 'missing-env', names: missing };
  const key = value.trim();
  return key ? { kind: 'value', value: key } : { kind: 'none' };
}

const positiveInt = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;

/** models.json 的模型列表 → ModelEntry：保留 name、reasoning、contextWindow、maxTokens（→ maxOutput）。 */
function piModels(raw: unknown): ModelEntry[] {
  const items = Array.isArray(raw) ? raw.map(asRecord).filter((item) => item !== null) : [];
  const byId = new Map(items.map((item) => [text(item.id), item]));
  const names = new Map(
    items.flatMap((item) => (text(item.name) ? [[text(item.id), text(item.name)] as const] : []))
  );
  return modelEntries([...byId.keys()].filter(Boolean), names).map((entry) => {
    const item = byId.get(entry.id);
    if (!item) return entry;
    const contextWindow = positiveInt(item.contextWindow);
    const maxOutput = positiveInt(item.maxTokens);
    return {
      ...entry,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
    };
  });
}

/** provider 的 api；没写时取模型上的 api（pi 允许按模型写）。不是 Fynvra 支持的协议返回 undefined。 */
function piApi(entry: Record<string, unknown>): ProviderApi | undefined {
  const own = text(entry.api);
  if (own) return isProviderApi(own) ? own : undefined;
  const first = Array.isArray(entry.models) ? asRecord(entry.models[0]) : null;
  const api = text(first?.api);
  return isProviderApi(api) ? api : undefined;
}

/**
 * `<agent-dir>/models.json`、`auth.json`、`settings.json` 的文本（不存在为 null）→ 服务：
 * - 只导入协议受支持、至少有一个模型的 provider；只覆盖地址等不完整的条目跳过并提示；
 * - 名称取 provider 键名（如 `sub2api`），导入后的服务 ID 与插件里按名查找的一致；
 * - key 与 pi 的优先级一致：auth.json 里 `type: 'api_key'` 的 key，其次 models.json 的 apiKey；
 *   命令型 key（`!…`）不执行，当作没有 key；
 * - settings.json 的 defaultProvider 标为当前。
 * models.json 坏了整个来源跳过；auth.json / settings.json 坏了只是没有它们的内容。
 */
export function readPi(input: {
  models: string | null;
  auth: string | null;
  settings?: string | null;
  env: Env;
}): ReaderResult {
  if (input.models === null) return { providers: [], warnings: [] };
  const models = parseJsonObject(input.models);
  if (!models) {
    return {
      providers: [],
      warnings: [translate('importers.invalidJson', { subject: 'pi', file: MODELS_FILE })],
    };
  }

  const warnings: string[] = [];
  let auth: Record<string, unknown> = {};
  if (input.auth !== null) {
    const parsed = parseJsonObject(input.auth);
    if (parsed) auth = parsed;
    else warnings.push(translate('importers.authIgnored', { subject: 'pi', file: AUTH_FILE }));
  }
  const settings = input.settings ? parseJsonObject(input.settings) : null;
  const defaultProvider = text(settings?.defaultProvider);

  const providers: DiscoveredProvider[] = [];
  for (const [id, raw] of Object.entries(asRecord(models.providers) ?? {})) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const subject = `pi · ${id}`;
    const api = piApi(entry);
    const entries = piModels(entry.models);
    if (!api || entries.length === 0) {
      const onlyBaseUrl = !text(entry.api) && !Array.isArray(entry.models) && text(entry.baseUrl);
      warnings.push(
        translate(onlyBaseUrl ? 'importers.piBaseUrlOnly' : 'importers.piIncomplete', { subject })
      );
      continue;
    }

    const stored = asRecord(auth[id]);
    const authKey = stored?.type === 'api_key' ? stored.key : undefined;
    const key = resolvePiKey(text(authKey) ? authKey : entry.apiKey, input.env);
    if (key.kind === 'command') {
      warnings.push(translate('importers.piCommandKey', { subject }));
    } else if (key.kind === 'missing-env') {
      warnings.push(
        translate('importers.envMissingKey', {
          subject,
          key: key.names.join(translate('importers.listSeparator')),
        })
      );
    }

    const baseUrl = baseUrlOf(entry.baseUrl);
    providers.push({
      source: 'pi',
      sourceLabel: 'pi',
      name: id,
      api,
      ...(baseUrl ? { baseUrl } : {}),
      ...(key.kind === 'value' ? { apiKey: key.value } : {}),
      models: entries,
      isCurrent: id === defaultProvider,
    });
  }
  return { providers, warnings };
}
