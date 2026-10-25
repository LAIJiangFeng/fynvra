import { asRecord } from '@shared/guards';
import type { ModelEntry } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import { baseUrlOf, modelEntries, parseJsonObject, type ReaderResult, text } from './common';

/** Claude Code 的模型别名（可带 `[1m]` 后缀）：实际指向哪个模型取决于端点，导入时忽略。 */
const MODEL_ALIASES = new Set(['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan']);
/** env 里的模型 id：ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_<档位>_MODEL（`<键>_NAME` 是它的显示名）。 */
const MODEL_ENV_KEY = /^ANTHROPIC_(?:DEFAULT_[A-Z0-9_]+_)?MODEL$/;

export interface AnthropicSettings {
  baseUrl?: string;
  apiKey?: string;
  models: ModelEntry[];
}

/**
 * Claude Code settings.json 里的服务（CC Switch 的 Claude 服务存的是同一份结构）：
 * env 的 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN（没有再取 ANTHROPIC_API_KEY）；
 * 模型依次取 `model`、env 的 ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_*_MODEL，别名忽略。
 * 既没有 key 也没有自定义地址（官方账号登录或空占位）时返回 null。
 */
export function readAnthropicSettings(settings: Record<string, unknown>): AnthropicSettings | null {
  const env = asRecord(settings.env) ?? {};
  const baseUrl = baseUrlOf(env.ANTHROPIC_BASE_URL);
  const apiKey = text(env.ANTHROPIC_AUTH_TOKEN) || text(env.ANTHROPIC_API_KEY);
  if (!baseUrl && !apiKey) return null;

  const ids = [text(settings.model)];
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    const id = text(value);
    if (!MODEL_ENV_KEY.test(key) || !id) continue;
    ids.push(id);
    const name = text(env[`${key}_NAME`]);
    if (name) names.set(id, name);
  }
  const concrete = ids.filter(
    (id) => id && !MODEL_ALIASES.has(id.replace(/\[[^\]]*\]$/, '').toLowerCase())
  );
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    models: modelEntries(concrete, names),
  };
}

/** `~/.claude/settings.json` 的文本 → 至多一个服务（Claude Code 正在用的那个）。 */
export function readClaudeCode(source: string): ReaderResult {
  const settings = parseJsonObject(source);
  if (!settings) {
    return {
      providers: [],
      warnings: [
        translate('importers.invalidJson', {
          subject: 'Claude Code',
          file: '~/.claude/settings.json',
        }),
      ],
    };
  }
  const found = readAnthropicSettings(settings);
  if (!found) return { providers: [], warnings: [] };
  return {
    providers: [
      {
        source: 'claude-code',
        sourceLabel: 'Claude Code',
        name: 'Claude Code',
        api: 'anthropic-messages',
        ...found,
        isCurrent: true,
      },
    ],
    warnings: [],
  };
}
