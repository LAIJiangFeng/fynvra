import { MEMORY_CATEGORIES } from '@shared/types/memory';
import { lastTouched, type MemoryRow } from './store';

// 注入用的索引文本（ARCHITECTURE §7.15「注入」）：纯函数，行里不放会变的信息，保住提示缓存。

export const INDEX_MAX_ENTRIES = 60;
export const INDEX_MAX_CHARS = 6000;
const LINE_CONTENT_CHARS = 150;

type IndexRow = Pick<
  MemoryRow,
  'id' | 'category' | 'content' | 'status' | 'pinned' | 'flagged_at' | 'last_used_at' | 'updated_at'
>;

/** 只取 active；pinned 在前 → 按类别顺序 → max(last_used_at, updated_at) 倒序。最多 60 条、合计 6000 字。 */
export function buildIndexText(rows: readonly IndexRow[]): string {
  const active = rows
    .filter((row) => row.status === 'active')
    .sort(
      (a, b) =>
        b.pinned - a.pinned ||
        MEMORY_CATEGORIES.indexOf(a.category) - MEMORY_CATEGORIES.indexOf(b.category) ||
        lastTouched(b) - lastTouched(a) ||
        b.id - a.id
    );
  const lines: string[] = [];
  let chars = 0;
  for (const row of active) {
    if (lines.length >= INDEX_MAX_ENTRIES) break;
    const content = [...row.content.replace(/\r?\n|\r/g, ' ')]
      .slice(0, LINE_CONTENT_CHARS)
      .join('');
    const line = `- #${row.id} [${row.category}] ${content}${row.flagged_at ? ' (reported outdated)' : ''}`;
    if (chars + line.length > INDEX_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  const rest = active.length - lines.length;
  if (rest > 0) lines.push(`另有 ${rest} 条，用 project_memory_search`);
  return lines.join('\n');
}
