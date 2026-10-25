import { asRecord } from '@shared/guards';
import type { ProviderApi } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import { readAnthropicSettings } from './claudeCode';
import { readCodexConfig } from './codex';
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

/** 读的 app_type 及分组顺序；claude-desktop、opencode、hermes 等其它类型跳过。 */
const APP_TYPES = ['claude', 'codex', 'gemini'] as const;
type AppType = (typeof APP_TYPES)[number];

/** CC Switch 的 meta.apiFormat → 协议；认不出的值视为没写。 */
function apiFromFormat(value: unknown): ProviderApi | undefined {
  switch (text(value).toLowerCase()) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'openai_responses':
      return 'openai-responses';
    case 'openai_chat':
      return 'openai-completions';
    default:
      return undefined;
  }
}

/** SQLite 的 BOOLEAN 列读出来是 0 / 1（也兼容 true 与 "1"）。 */
function isTruthy(value: unknown): boolean {
  return value === 1 || value === 1n || value === true || value === '1' || value === 'true';
}

type Found = Pick<DiscoveredProvider, 'api' | 'baseUrl' | 'apiKey' | 'models'>;

/**
 * cc-switch.db 里 providers 表的行 → 服务。按 Claude / Codex / Gemini 分组，组内当前在用的排前面
 * （去重时保留排在前面的）。settings_config 为空的官方占位跳过；单行坏了只记 warning、跳过那一行。
 */
export function readCcSwitch(rows: readonly Record<string, unknown>[], env: Env): ReaderResult {
  const providers: DiscoveredProvider[] = [];
  const warnings: string[] = [];
  const ordered = rows
    .map((row, index) => ({
      row,
      index,
      app: text(row.app_type).toLowerCase() as AppType,
      current: isTruthy(row.is_current),
    }))
    .filter(({ app }) => APP_TYPES.includes(app))
    .sort(
      (a, b) =>
        APP_TYPES.indexOf(a.app) - APP_TYPES.indexOf(b.app) ||
        Number(b.current) - Number(a.current) ||
        a.index - b.index
    );

  for (const { row, app, current } of ordered) {
    const name = text(row.name) || app;
    const sourceLabel = `CC Switch · ${name}`;
    const settings = parseJsonObject(text(row.settings_config));
    if (!settings) {
      warnings.push(
        translate('importers.configInvalidJson', { subject: sourceLabel, field: 'settings_config' })
      );
      continue;
    }
    const format = apiFromFormat(parseJsonObject(text(row.meta))?.apiFormat);
    const found = readRow(app, settings, format, env, (warning) =>
      warnings.push(translate('importers.labeled', { subject: sourceLabel, text: warning }))
    );
    if (found) {
      providers.push({ source: 'cc-switch', sourceLabel, name, ...found, isCurrent: current });
    }
  }
  return { providers, warnings };
}

function readRow(
  app: AppType,
  settings: Record<string, unknown>,
  format: ProviderApi | undefined,
  env: Env,
  warn: (warning: string) => void
): Found | null {
  switch (app) {
    case 'claude': {
      const found = readAnthropicSettings(settings);
      return found && { api: format ?? 'anthropic-messages', ...found };
    }
    case 'codex': {
      // settings_config = { auth: <auth.json>, config: <config.toml 文本> }
      const auth = asRecord(settings.auth);
      const toml = text(settings.config);
      if (!toml && !text(auth?.OPENAI_API_KEY)) return null;
      const parsed = parseTomlObject(toml);
      if (!parsed.ok) {
        warn(
          parsed.line
            ? translate('importers.codexConfigInvalidAt', { line: parsed.line })
            : translate('importers.codexConfigInvalid')
        );
        return null;
      }
      const active = readCodexConfig(parsed.value, auth, env, format).find((p) => p.active);
      if (!active) return null;
      if (active.missingEnvKey) {
        warn(translate('importers.envMissingInConfig', { key: active.missingEnvKey }));
      }
      const { api, baseUrl, apiKey, models } = active;
      return { api, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), models };
    }
    case 'gemini': {
      const vars = asRecord(settings.env) ?? {};
      const baseUrl = baseUrlOf(vars.GOOGLE_GEMINI_BASE_URL);
      const apiKey = text(vars.GEMINI_API_KEY) || text(vars.GOOGLE_API_KEY);
      if (!baseUrl && !apiKey) return null;
      const model = text(vars.GEMINI_MODEL);
      return {
        api: 'google-generative-ai',
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        models: model ? modelEntries([model]) : [],
      };
    }
  }
}
