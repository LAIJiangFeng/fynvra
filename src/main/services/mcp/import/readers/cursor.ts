import { type ReaderResult, readJsonObject, readServerMap, type SourceFile } from './common';

const LABEL = 'Cursor';

/** ~/.cursor/mcp.json：`mcpServers`，与 Claude 同一格式。 */
export function readCursor(files: readonly SourceFile[]): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const config = readJsonObject(file, LABEL, warnings);
    return config
      ? readServerMap(config.mcpServers, { source: 'cursor', sourceLabel: LABEL }, warnings)
      : [];
  });
  return { servers, warnings };
}
