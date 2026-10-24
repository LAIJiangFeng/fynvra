import { MODEL_CATALOG } from '@shared/modelCatalog';
import type { ProviderImportCandidate, ProviderImportSource } from '@shared/types/llm';

// 「从本机导入」弹窗的纯逻辑：不碰 DOM 与 window.fynvra，在 node 下测试。

/** 来源开关的顺序与 Main 的去重优先级一致：重复的候选保留排在前面的。 */
export const IMPORT_SOURCES: ReadonlyArray<{
  id: ProviderImportSource;
  label: string;
  /** 读的是哪个文件，作为开关的提示 */
  path: string;
}> = [
  { id: 'claude-code', label: 'Claude Code', path: '~/.claude/settings.json' },
  { id: 'codex', label: 'Codex', path: '~/.codex/config.toml' },
  { id: 'cc-switch', label: 'CC Switch', path: '~/.cc-switch/cc-switch.db' },
];

const ALL_SOURCE_IDS = IMPORT_SOURCES.map((source) => source.id);

export function sourceLabel(source: ProviderImportSource): string {
  return IMPORT_SOURCES.find((entry) => entry.id === source)?.label ?? source;
}

/** 开关一个来源；结果保持 Claude Code、Codex、CC Switch 的顺序。 */
export function toggleSource(
  current: readonly ProviderImportSource[],
  source: ProviderImportSource,
  on: boolean
): ProviderImportSource[] {
  return ALL_SOURCE_IDS.filter((id) => (id === source ? on : current.includes(id)));
}

/** 重复的候选（与已有服务或排在前面的候选地址和 key 都相同）不能勾选。 */
const selectable = (candidates: readonly ProviderImportCandidate[]) =>
  candidates.filter((candidate) => !candidate.duplicate);

/** 默认勾选：正在使用且不重复的。CC Switch 里攒的旧服务通常不想一次全导进来。 */
export function defaultSelection(candidates: readonly ProviderImportCandidate[]): string[] {
  return selectable(candidates)
    .filter((candidate) => candidate.isCurrent)
    .map((candidate) => candidate.id);
}

export function selectAll(candidates: readonly ProviderImportCandidate[]): string[] {
  return selectable(candidates).map((candidate) => candidate.id);
}

export function invertSelection(
  candidates: readonly ProviderImportCandidate[],
  selected: readonly string[]
): string[] {
  return selectable(candidates)
    .filter((candidate) => !selected.includes(candidate.id))
    .map((candidate) => candidate.id);
}

/** 提交时按候选的顺序（Main 对同批重复保留排前面的），丢掉已不在列表里的 id。 */
export function orderedSelection(
  candidates: readonly ProviderImportCandidate[],
  selected: readonly string[]
): string[] {
  return candidates
    .filter((candidate) => selected.includes(candidate.id))
    .map((candidate) => candidate.id);
}

export function duplicateReason(candidate: ProviderImportCandidate): string | null {
  if (candidate.duplicate === 'existing') {
    return `已有地址和 API Key 都相同的服务「${candidate.duplicateOf ?? ''}」`;
  }
  if (candidate.duplicate === 'candidate') {
    return `与上面的「${candidate.duplicateOf ?? ''}」地址和 API Key 都相同`;
  }
  return null;
}

const MAX_LISTED_MODELS = 3;

export function modelSummary(candidate: ProviderImportCandidate): string {
  const { models } = candidate;
  if (models.length === 0) {
    const hasPreset = MODEL_CATALOG.some(
      (entry) => entry.api === candidate.api && entry.models.length > 0
    );
    return hasPreset ? '未写模型：导入时使用内置的预置模型' : '未写模型：导入后在「编辑」里添加';
  }
  const names = models
    .slice(0, MAX_LISTED_MODELS)
    .map((model) => model.name)
    .join('、');
  return models.length > MAX_LISTED_MODELS
    ? `模型：${names} 等 ${models.length} 个`
    : `模型：${names}`;
}

export function importSummary(result: {
  imported: ReadonlyArray<{ name: string }>;
  skipped: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const done = `已导入 ${result.imported.length} 个模型服务`;
  if (result.skipped.length === 0) return done;
  const skipped = result.skipped.map((item) => `${item.name}（${item.reason}）`).join('、');
  return `${done}；跳过 ${result.skipped.length} 个：${skipped}`;
}
