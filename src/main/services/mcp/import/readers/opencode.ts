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
} from './common';

const LABEL = 'OpenCode';

/**
 * `mcp.<name>`：`{ type: 'local', command: string[], environment, enabled }`（command 第一个元素是命令，其余是参数）
 * 或 `{ type: 'remote', url, headers, enabled }`（按 Streamable HTTP）。没写 type 时有 url 算 remote。
 */
function openCodeServer(name: string, raw: unknown): ImportedMcpServer | null {
  const config = asRecord(raw);
  if (!config) return null;
  const type = text(config.type).toLowerCase();
  const url = text(config.url);
  if (type === 'remote' || (type !== 'local' && url)) {
    return url ? remoteServer(name, 'http', url, stringRecord(config.headers)) : null;
  }
  const [command = '', ...args] = Array.isArray(config.command)
    ? stringArray(config.command)
    : [text(config.command)];
  return command.trim()
    ? stdioServer(name, command.trim(), args, stringRecord(config.environment))
    : null;
}

/** ~/.config/opencode/opencode.json（或 .jsonc）。 */
export function readOpenCode(files: readonly SourceFile[]): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const config = readJsonObject(file, LABEL, warnings);
    return config
      ? readServerMap(config.mcp, { source: 'opencode', sourceLabel: LABEL }, warnings, {
          read: openCodeServer,
        })
      : [];
  });
  return { servers, warnings };
}
