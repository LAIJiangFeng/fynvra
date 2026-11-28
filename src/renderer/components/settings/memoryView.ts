import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryView } from '@shared/types/memory';

const STATUS_ORDER = { active: 0, disabled: 1, expired: 2 } as const;

/** 按类别分组（固定顺序，跳过空组）；组内生效的在前，同状态按更新时间倒序 */
export function groupMemories(
  memories: readonly MemoryView[]
): { category: MemoryCategory; items: MemoryView[] }[] {
  return MEMORY_CATEGORIES.map((category) => ({
    category,
    items: memories
      .filter((memory) => memory.category === category)
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt),
  })).filter((group) => group.items.length > 0);
}
