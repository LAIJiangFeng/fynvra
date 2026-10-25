import type { McpImportCandidate, McpImportSource } from '@shared/types/llm';
import { type T, translate } from '../../i18n';
import { skippedSummary } from './providerImport';

// 「从本机导入」MCP 服务器弹窗的纯逻辑：不碰 DOM 与 window.fynvra，在 node 下测试。

/** 来源开关的顺序与 Main 的去重优先级一致：重复的候选保留排在前面的。 */
export const MCP_IMPORT_SOURCES: ReadonlyArray<{
  id: McpImportSource;
  label: string;
  /** 读的是哪个文件，作为开关的提示 */
  path: string;
}> = [
  { id: 'claude-code', label: 'Claude Code', path: '~/.claude.json, ~/.claude/settings.json' },
  { id: 'codex', label: 'Codex', path: '~/.codex/config.toml' },
  { id: 'grok', label: 'Grok CLI', path: '~/.grok/config.toml' },
  { id: 'gemini', label: 'Gemini CLI', path: '~/.gemini/settings.json' },
  { id: 'cursor', label: 'Cursor', path: '~/.cursor/mcp.json' },
  { id: 'vscode', label: 'VS Code', path: 'mcp.json' },
  { id: 'opencode', label: 'OpenCode', path: '~/.config/opencode/opencode.json' },
  { id: 'cc-switch', label: 'CC Switch', path: '~/.cc-switch/cc-switch.db' },
];

const ALL_SOURCE_IDS = MCP_IMPORT_SOURCES.map((source) => source.id);

/** 来源开关的悬停提示：读哪个文件；需要说明的两个按界面语言 */
export function mcpSourcePath(source: (typeof MCP_IMPORT_SOURCES)[number], t: T): string {
  if (source.id === 'claude-code') return t('settings.mcp.claudeCodePath');
  if (source.id === 'vscode') return t('settings.mcp.vscodePath');
  return source.path;
}

export function mcpSourceLabel(source: McpImportSource): string {
  return MCP_IMPORT_SOURCES.find((entry) => entry.id === source)?.label ?? source;
}

/** 开关一个来源；结果保持来源的固定顺序。 */
export function toggleMcpSource(
  current: readonly McpImportSource[],
  source: McpImportSource,
  on: boolean
): McpImportSource[] {
  return ALL_SOURCE_IDS.filter((id) => (id === source ? on : current.includes(id)));
}

/** 重复的候选（与已有服务器或排在前面的候选命令 + 参数 / URL 相同）不能勾选。 */
const selectable = (candidates: readonly McpImportCandidate[]) =>
  candidates.filter((candidate) => !candidate.duplicate);

/** 默认勾选：在来源里已启用且不重复的。来源里停用的通常是不想用的。 */
export function defaultSelection(candidates: readonly McpImportCandidate[]): string[] {
  return selectable(candidates)
    .filter((candidate) => candidate.enabledInSource)
    .map((candidate) => candidate.id);
}

export function selectAll(candidates: readonly McpImportCandidate[]): string[] {
  return selectable(candidates).map((candidate) => candidate.id);
}

export function invertSelection(
  candidates: readonly McpImportCandidate[],
  selected: readonly string[]
): string[] {
  return selectable(candidates)
    .filter((candidate) => !selected.includes(candidate.id))
    .map((candidate) => candidate.id);
}

/** 提交时按候选的顺序（Main 对同批重复保留排前面的），丢掉已不在列表里的 id。 */
export function orderedSelection(
  candidates: readonly McpImportCandidate[],
  selected: readonly string[]
): string[] {
  return candidates
    .filter((candidate) => selected.includes(candidate.id))
    .map((candidate) => candidate.id);
}

export function duplicateReason(candidate: McpImportCandidate): string | null {
  const name = candidate.duplicateOf ?? '';
  if (candidate.duplicate === 'existing') {
    return candidate.url
      ? translate('settings.mcp.duplicateExistingUrl', { name })
      : translate('settings.mcp.duplicateExistingCommand', { name });
  }
  if (candidate.duplicate === 'candidate') {
    return candidate.url
      ? translate('settings.mcp.duplicateCandidateUrl', { name })
      : translate('settings.mcp.duplicateCandidateCommand', { name });
  }
  return null;
}

/** 重复项在行里的徽标，原因（{@link duplicateReason}）悬停显示：与已有服务器相同是「已有」，与上面的候选相同是「重复」 */
export function duplicateBadge(candidate: McpImportCandidate): string | null {
  if (candidate.duplicate === 'existing') return translate('settings.import.existing');
  if (candidate.duplicate === 'candidate') return translate('settings.import.duplicate');
  return null;
}

/** 一行摘要：stdio 是命令加参数，远程是 URL。 */
export function commandSummary(candidate: McpImportCandidate): string {
  return candidate.url ?? [candidate.command ?? '', ...(candidate.args ?? [])].join(' ');
}

export function importSummary(result: {
  imported: ReadonlyArray<{ name: string }>;
  skipped: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const done = translate('settings.mcp.imported', { count: result.imported.length });
  return skippedSummary(done, result.skipped);
}
