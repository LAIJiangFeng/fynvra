import type { McpImportCandidate, McpImportSource } from '@shared/types/llm';

// 「从本机导入」MCP 服务器弹窗的纯逻辑：不碰 DOM 与 window.fynvra，在 node 下测试。

/** 来源开关的顺序与 Main 的去重优先级一致：重复的候选保留排在前面的。 */
export const MCP_IMPORT_SOURCES: ReadonlyArray<{
  id: McpImportSource;
  label: string;
  /** 读的是哪个文件，作为开关的提示 */
  path: string;
}> = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: '~/.claude.json（含各项目）、~/.claude/settings.json',
  },
  { id: 'codex', label: 'Codex', path: '~/.codex/config.toml' },
  { id: 'grok', label: 'Grok CLI', path: '~/.grok/config.toml' },
  { id: 'gemini', label: 'Gemini CLI', path: '~/.gemini/settings.json' },
  { id: 'cursor', label: 'Cursor', path: '~/.cursor/mcp.json' },
  { id: 'vscode', label: 'VS Code', path: 'VS Code 用户目录里的 mcp.json（含 Insiders）' },
  { id: 'opencode', label: 'OpenCode', path: '~/.config/opencode/opencode.json' },
  { id: 'cc-switch', label: 'CC Switch', path: '~/.cc-switch/cc-switch.db' },
];

const ALL_SOURCE_IDS = MCP_IMPORT_SOURCES.map((source) => source.id);

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
  const what = candidate.url ? ' URL ' : '命令和参数';
  if (candidate.duplicate === 'existing') {
    return `已有${what}相同的服务器「${candidate.duplicateOf ?? ''}」`;
  }
  if (candidate.duplicate === 'candidate') {
    return `与上面的「${candidate.duplicateOf ?? ''}」${what}相同`;
  }
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
  const done = `已导入 ${result.imported.length} 个 MCP 服务器`;
  if (result.skipped.length === 0) return done;
  const skipped = result.skipped.map((item) => `${item.name}（${item.reason}）`).join('、');
  return `${done}；跳过 ${result.skipped.length} 个：${skipped}`;
}
