import { type ReaderResult, readJsonObject, readServerMap, type SourceFile } from './common';

/**
 * VS Code 用户目录下的 mcp.json（JSONC）：`servers.<name>` 是 `{ type: 'stdio', command, args, env }` 或
 * `{ type: 'http' | 'sse', url, headers }`；`inputs`（运行时弹框询问的值）不读。Insiders 的文件单独标注。
 */
export function readVsCode(files: readonly SourceFile[]): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const label = /code - insiders/i.test(file.file) ? 'VS Code Insiders' : 'VS Code';
    const config = readJsonObject(file, label, warnings);
    return config
      ? readServerMap(config.servers, { source: 'vscode', sourceLabel: label }, warnings)
      : [];
  });
  return { servers, warnings };
}
