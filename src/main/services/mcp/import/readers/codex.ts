import { asRecord } from '@shared/guards';
import type { McpImportSource } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import { parseTomlObject } from '../../../providers/import/readers/common';
import {
  type Env,
  type ImportedMcpServer,
  type ReaderResult,
  readServerMap,
  remoteServer,
  type SourceFile,
  stdioServer,
  stringArray,
  stringRecord,
  text,
  toTransport,
} from './common';

// Codex（~/.codex/config.toml）与 Grok CLI（~/.grok/config.toml）的 [mcp_servers.<name>] 是同一种格式。

/** env_vars 的每一项：变量名，或 `{ name, source }`。 */
function envVarNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : text(asRecord(item)?.name)))
    .filter(Boolean);
}

/**
 * 一条 [mcp_servers.<name>]：
 * - stdio：command、args、env（子表）。env_vars 列的是要从环境透传的变量名：fynvra 没有透传，导入时按当时的
 *   环境变量取值写进 env（env 里已写的不覆盖），取不到的记进 `missing`；
 * - 远程：url、http_headers（子表）。env_http_headers（header → 变量名）与 bearer_token_env_var 同样按环境变量取值。
 *   Codex 没有 SSE，没写 type 都按 Streamable HTTP；
 * - startup_timeout_sec 等 fynvra 没有对应字段的忽略；是否启用由 readServerMap 看 enabled。
 */
function codexServer(
  name: string,
  raw: unknown,
  env: Env,
  missing: string[]
): ImportedMcpServer | null {
  const config = asRecord(raw);
  if (!config) return null;
  const command = text(config.command);
  const url = text(config.url);
  const fromEnv = (target: Record<string, string>, key: string, variable: string) => {
    const value = env[variable];
    if (value === undefined) missing.push(variable);
    else target[key] = value;
  };

  if (toTransport(config.type ?? config.transport, url !== '') === 'stdio') {
    if (!command) return null;
    const vars = stringRecord(config.env);
    for (const variable of envVarNames(config.env_vars)) {
      if (!Object.hasOwn(vars, variable)) fromEnv(vars, variable, variable);
    }
    return stdioServer(name, command, stringArray(config.args), vars);
  }

  if (!url) return null;
  const headers = { ...stringRecord(config.headers), ...stringRecord(config.http_headers) };
  for (const [header, variable] of Object.entries(stringRecord(config.env_http_headers))) {
    if (!Object.hasOwn(headers, header) && variable.trim())
      fromEnv(headers, header, variable.trim());
  }
  const bearer = text(config.bearer_token_env_var);
  if (bearer && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    const token = env[bearer];
    if (token === undefined) missing.push(bearer);
    else headers.Authorization = `Bearer ${token}`;
  }
  return remoteServer(
    name,
    toTransport(config.type, true) === 'sse' ? 'sse' : 'http',
    url,
    headers
  );
}

function readCodexToml(
  files: readonly SourceFile[],
  env: Env,
  source: McpImportSource,
  label: string
): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const parsed = parseTomlObject(file.text);
    if (!parsed.ok) {
      warnings.push(
        parsed.line === undefined
          ? translate('importers.invalidToml', { subject: label, file: file.file })
          : translate('importers.invalidTomlAt', {
              subject: label,
              file: file.file,
              line: parsed.line,
            })
      );
      return [];
    }
    return readServerMap(parsed.value.mcp_servers, { source, sourceLabel: label }, warnings, {
      read: (name, config) => {
        const missing: string[] = [];
        const server = codexServer(name, config, env, missing);
        if (server && missing.length > 0) {
          warnings.push(
            translate('importers.envMissing', {
              subject: `${label} · ${name}`,
              keys: missing.join(translate('importers.listSeparator')),
            })
          );
        }
        return server;
      },
    });
  });
  return { servers, warnings };
}

/** ~/.codex/config.toml。 */
export function readCodex(files: readonly SourceFile[], env: Env): ReaderResult {
  return readCodexToml(files, env, 'codex', 'Codex');
}

/** ~/.grok/config.toml：字段同 Codex。 */
export function readGrok(files: readonly SourceFile[], env: Env): ReaderResult {
  return readCodexToml(files, env, 'grok', 'Grok CLI');
}
