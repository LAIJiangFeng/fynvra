import { asRecord } from '@shared/guards';
import type { ModelEntry, ProviderApi } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import {
  baseUrlOf,
  type DiscoveredProvider,
  type Env,
  modelEntries,
  parseJsonObject,
  parseTomlObject,
  type ReaderResult,
  text,
} from './common';

/** Codex 内置的 OpenAI 服务：model_provider 缺省时就是它，key 来自 auth.json。 */
const BUILTIN_OPENAI = 'openai';

export interface CodexProvider {
  /** `[model_providers.<key>]` 的键；内置 OpenAI 为 `openai` */
  key: string;
  name: string;
  api: ProviderApi;
  baseUrl?: string;
  apiKey?: string;
  models: ModelEntry[];
  /** model_provider 选中的那一个 */
  active: boolean;
  /** key 应来自这个环境变量，但它没有设置 */
  missingEnvKey?: string;
}

/** wire_api：responses → openai-responses，chat → openai-completions；其它值视为没写。 */
function wireApi(value: unknown): ProviderApi | undefined {
  const wire = text(value).toLowerCase();
  if (wire === 'responses') return 'openai-responses';
  if (wire === 'chat') return 'openai-completions';
  return undefined;
}

/**
 * 已解析的 config.toml 与 auth.json 里的服务（CC Switch 的 Codex 服务存的是同一份内容）：
 * - `[model_providers.<key>]` 取 name、base_url、wire_api（没写时用 `defaultApi`，再缺省按 Codex 的默认 chat）；
 *   没有 base_url 的跳过；
 * - key 与 Codex 的取法一致：有 env_key 取那个环境变量，requires_openai_auth 才用 auth.json 的 OPENAI_API_KEY，
 *   不把 OpenAI 的 key 带给不需要它的端点；
 * - 顶层 `model` 只属于 model_provider 选中的服务，它排在最前；
 * - model_provider 缺省或为 openai 时用的是内置 OpenAI，auth.json 里有 OPENAI_API_KEY 才算（ChatGPT 登录没有 key）。
 */
export function readCodexConfig(
  config: Record<string, unknown>,
  auth: Record<string, unknown> | null,
  env: Env,
  defaultApi: ProviderApi = 'openai-completions'
): CodexProvider[] {
  const authKey = text(auth?.OPENAI_API_KEY);
  const selected = text(config.model_provider) || BUILTIN_OPENAI;
  const model = text(config.model);
  const providers: CodexProvider[] = [];

  for (const [key, raw] of Object.entries(asRecord(config.model_providers) ?? {})) {
    const entry = asRecord(raw);
    const baseUrl = baseUrlOf(entry?.base_url);
    if (!entry || !baseUrl) continue;
    const envKey = text(entry.env_key);
    const apiKey = envKey ? text(env[envKey]) : entry.requires_openai_auth === true ? authKey : '';
    const active = key === selected;
    providers.push({
      key,
      name: text(entry.name) || key,
      api: wireApi(entry.wire_api) ?? defaultApi,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      models: active && model ? modelEntries([model]) : [],
      active,
      ...(envKey && !apiKey ? { missingEnvKey: envKey } : {}),
    });
  }

  if (selected === BUILTIN_OPENAI && authKey && !providers.some((p) => p.key === BUILTIN_OPENAI)) {
    providers.push({
      key: BUILTIN_OPENAI,
      name: 'OpenAI',
      api: 'openai-responses',
      apiKey: authKey,
      models: model ? modelEntries([model]) : [],
      active: true,
    });
  }
  return providers.sort((a, b) => Number(b.active) - Number(a.active));
}

/**
 * `~/.codex/config.toml` 与 `~/.codex/auth.json` 的文本（不存在为 null）→ 服务。选中的服务叫「Codex」
 * （内置 OpenAI 叫「OpenAI」），其它的叫「Codex · <name>」。config.toml 坏了整个来源跳过；auth.json 坏了只是没有它的 key。
 */
export function readCodex(input: {
  config: string | null;
  auth: string | null;
  env: Env;
}): ReaderResult {
  let config: Record<string, unknown> = {};
  if (input.config !== null) {
    const parsed = parseTomlObject(input.config);
    if (!parsed.ok) {
      return {
        providers: [],
        warnings: [
          parsed.line
            ? translate('importers.invalidTomlAt', {
                subject: 'Codex',
                file: '~/.codex/config.toml',
                line: parsed.line,
              })
            : translate('importers.invalidToml', {
                subject: 'Codex',
                file: '~/.codex/config.toml',
              }),
        ],
      };
    }
    config = parsed.value;
  }

  const warnings: string[] = [];
  let auth: Record<string, unknown> | null = null;
  if (input.auth !== null) {
    auth = parseJsonObject(input.auth);
    if (!auth) {
      warnings.push(
        translate('importers.authIgnored', { subject: 'Codex', file: '~/.codex/auth.json' })
      );
    }
  }

  const providers = readCodexConfig(config, auth, input.env).map(
    ({ key, name, active, missingEnvKey, ...rest }): DiscoveredProvider => {
      const label = active ? 'Codex' : `Codex · ${name}`;
      if (missingEnvKey) {
        warnings.push(translate('importers.envMissingKey', { subject: label, key: missingEnvKey }));
      }
      return {
        source: 'codex',
        sourceLabel: label,
        name: key === BUILTIN_OPENAI && !rest.baseUrl ? 'OpenAI' : label,
        ...rest,
        isCurrent: active,
      };
    }
  );
  return { providers, warnings };
}
