import { asRecord } from '@shared/guards';
import {
  type ImportedMcpServer,
  type ReaderResult,
  readJsonObject,
  readServerMap,
  remoteServer,
  type SourceFile,
  stdioServer,
  stringArray,
  stringRecord,
  text,
  toTransport,
} from './common';

const LABEL = 'Gemini CLI';

/**
 * ~/.gemini/settings.json 的 `mcpServers.<name>`，按 Gemini CLI 的优先级：httpUrl（Streamable HTTP）→
 * url（SSE；写了 type: "http" 时按 Streamable HTTP）→ command（stdio）。timeout、trust、cwd 等忽略。
 */
function geminiServer(name: string, raw: unknown): ImportedMcpServer | null {
  const config = asRecord(raw);
  if (!config) return null;
  const headers = stringRecord(config.headers);
  const httpUrl = text(config.httpUrl);
  if (httpUrl) return remoteServer(name, 'http', httpUrl, headers);
  const url = text(config.url);
  if (url) {
    return remoteServer(
      name,
      toTransport(config.type, false) === 'http' ? 'http' : 'sse',
      url,
      headers
    );
  }
  const command = text(config.command);
  return command
    ? stdioServer(name, command, stringArray(config.args), stringRecord(config.env))
    : null;
}

/** mcp.allowed（设了就只连列出的）与 mcp.excluded；旧版设置叫 allowMCPServers / excludeMCPServers。 */
function enabledRule(settings: Record<string, unknown>): (name: string) => boolean {
  const mcp = asRecord(settings.mcp);
  const allowedRaw = mcp?.allowed ?? settings.allowMCPServers;
  const allowed = Array.isArray(allowedRaw) ? stringArray(allowedRaw) : null;
  const excluded = new Set(stringArray(mcp?.excluded ?? settings.excludeMCPServers));
  return (name) => !excluded.has(name) && (allowed === null || allowed.includes(name));
}

/** ~/.gemini/settings.json。 */
export function readGemini(files: readonly SourceFile[]): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const settings = readJsonObject(file, LABEL, warnings);
    if (!settings) return [];
    return readServerMap(settings.mcpServers, { source: 'gemini', sourceLabel: LABEL }, warnings, {
      read: geminiServer,
      enabled: enabledRule(settings),
    });
  });
  return { servers, warnings };
}
