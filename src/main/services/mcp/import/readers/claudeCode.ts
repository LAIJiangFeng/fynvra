import { asRecord } from '@shared/guards';
import {
  type DiscoveredMcpServer,
  type ReaderResult,
  readJsonObject,
  readServerMap,
  type SourceFile,
} from './common';

const LABEL = 'Claude Code';

/** 项目路径（如 `D:/project/fynvra`）的最后一段，作为项目级服务器的标签。 */
function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * 已解析的 ~/.claude.json 或 ~/.claude/settings.json：顶层 mcpServers（用户级），以及
 * `projects.<路径>.mcpServers`（项目级，标签带项目目录名）。Claude Code 没有逐个停用的开关，都算启用。
 */
export function claudeConfigServers(
  config: Record<string, unknown>,
  warnings: string[] = []
): DiscoveredMcpServer[] {
  const servers = readServerMap(
    config.mcpServers,
    { source: 'claude-code', sourceLabel: LABEL },
    warnings
  );
  for (const [path, project] of Object.entries(asRecord(config.projects) ?? {})) {
    servers.push(
      ...readServerMap(
        asRecord(project)?.mcpServers,
        { source: 'claude-code', sourceLabel: `${LABEL} · ${projectName(path)}` },
        warnings
      )
    );
  }
  return servers;
}

/** Claude Code 的配置文件（~/.claude.json、~/.claude/settings.json，不存在的不传）。 */
export function readClaudeCode(files: readonly SourceFile[]): ReaderResult {
  const warnings: string[] = [];
  const servers = files.flatMap((file) => {
    const config = readJsonObject(file, LABEL, warnings);
    return config ? claudeConfigServers(config, warnings) : [];
  });
  return { servers, warnings };
}
