import { MODEL_CATALOG } from '@shared/modelCatalog';
import type {
  ModelProviderView,
  ProviderImportCandidate,
  ProviderImportSource,
} from '@shared/types/llm';
import { translate } from '../../i18n';

// 「从本机导入」弹窗的纯逻辑：不碰 DOM 与 window.fynvra，在 node 下测试。

export interface ImportModelQueue {
  providers: readonly ModelProviderView[];
  index: number;
}

/** 只为成功导入的服务排队；顺序沿用 Main 的导入结果，不包含跳过的候选。 */
export function createImportModelQueue(
  imported: readonly ModelProviderView[]
): ImportModelQueue | null {
  return imported.length > 0 ? { providers: [...imported], index: 0 } : null;
}

/** 保存成功或跳过当前服务后进入下一项；全部跳过 / 已到末尾则结束。 */
export function advanceImportModelQueue(
  queue: ImportModelQueue,
  action: 'saved' | 'skip' | 'skip-all'
): ImportModelQueue | null {
  const index = queue.index + 1;
  return action === 'skip-all' || index >= queue.providers.length ? null : { ...queue, index };
}

/** 导入结果一行：导入了几个，有跳过的再列出「名称（原因）」；MCP 导入共用 */
export function skippedSummary(
  done: string,
  skipped: ReadonlyArray<{ name: string; reason: string }>
): string {
  if (skipped.length === 0) return done;
  const items = skipped
    .map((item) => translate('settings.import.skippedItem', item))
    .join(translate('settings.import.itemSeparator'));
  return translate('settings.import.skipped', { done, count: skipped.length, items });
}

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
    return translate('settings.providers.duplicateExisting', { name: candidate.duplicateOf ?? '' });
  }
  if (candidate.duplicate === 'candidate') {
    return translate('settings.providers.duplicateCandidate', {
      name: candidate.duplicateOf ?? '',
    });
  }
  return null;
}

/** 重复项在行里的徽标，原因（{@link duplicateReason}）悬停显示：与已有服务相同是「已有」，与上面的候选相同是「重复」 */
export function duplicateBadge(candidate: ProviderImportCandidate): string | null {
  if (candidate.duplicate === 'existing') return translate('settings.import.existing');
  if (candidate.duplicate === 'candidate') return translate('settings.import.duplicate');
  return null;
}

const MAX_LISTED_MODELS = 3;

export function modelSummary(candidate: ProviderImportCandidate): string {
  const { models } = candidate;
  if (models.length === 0) {
    const hasPreset = MODEL_CATALOG.some(
      (entry) => entry.api === candidate.api && entry.models.length > 0
    );
    return translate(
      hasPreset ? 'settings.providers.noModelsPreset' : 'settings.providers.noModelsListed'
    );
  }
  const names = models
    .slice(0, MAX_LISTED_MODELS)
    .map((model) => model.name)
    .join(translate('settings.import.itemSeparator'));
  return models.length > MAX_LISTED_MODELS
    ? translate('settings.providers.modelsMore', { names, count: models.length })
    : translate('settings.providers.modelsList', { names });
}

export function importSummary(result: {
  imported: ReadonlyArray<{ name: string }>;
  skipped: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const done = translate('settings.providers.imported', { count: result.imported.length });
  return skippedSummary(done, result.skipped);
}
