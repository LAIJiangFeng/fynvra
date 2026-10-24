import { asRecord } from '@shared/guards';
import { parseJsonc } from '../jsonc';
import { type DiscoveredMcpServer, type ReaderResult, readServerConfig, text } from './common';

/** mcp_servers 表里 enabled_<应用> 列的显示名；认不出的列按列名后缀显示。 */
const APP_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  hermes: 'Hermes',
};
const ENABLED_PREFIX = 'enabled_';

/** SQLite 的 BOOLEAN 列读出来是 0 / 1（也兼容 1n、true 与 "1"）。 */
function isTruthy(value: unknown): boolean {
  return value === 1 || value === 1n || value === true || value === '1' || value === 'true';
}

/**
 * cc-switch.db 里 mcp_servers 表的行 → 服务器。server_config 是 Claude 格式的 JSON；
 * 标签列出已启用它的应用（enabled_claude / enabled_codex / …），一个都没有就算未启用。单行坏了只跳过那一行。
 */
export function readCcSwitch(rows: readonly Record<string, unknown>[]): ReaderResult {
  const servers: DiscoveredMcpServer[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    const name = text(row.name) || text(row.id);
    if (!name) continue;
    const apps = Object.keys(row)
      .filter((key) => key.startsWith(ENABLED_PREFIX) && isTruthy(row[key]))
      .map((key) => {
        const app = key.slice(ENABLED_PREFIX.length);
        return APP_NAMES[app] ?? app;
      });
    const parsed = parseJsonc(text(row.server_config));
    const config = parsed.ok ? asRecord(parsed.value) : null;
    if (!config) {
      warnings.push(`CC Switch · ${name}：server_config 不是有效的 JSON，已跳过`);
      continue;
    }
    const server = readServerConfig(name, config);
    if (!server) {
      warnings.push(`CC Switch · ${name}：没有命令或 URL，已跳过`);
      continue;
    }
    servers.push({
      ...server,
      source: 'cc-switch',
      sourceLabel: apps.length > 0 ? `CC Switch · ${apps.join('、')}` : 'CC Switch',
      enabledInSource: apps.length > 0,
    });
  }
  return { servers, warnings };
}
