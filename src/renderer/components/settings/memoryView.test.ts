import type { MemoryView } from '@shared/types/memory';
import { describe, expect, it } from 'vitest';
import { groupMemories } from './memoryView';

const memory = (patch: Partial<MemoryView> & Pick<MemoryView, 'id'>): MemoryView => ({
  category: 'rule',
  content: `m${patch.id}`,
  status: 'active',
  pinned: false,
  sourceKind: 'user',
  files: [],
  createdAt: 0,
  updatedAt: 0,
  useCount: 0,
  ...patch,
});

describe('groupMemories', () => {
  it('按类别固定顺序分组、跳过空组，组内生效在前再按更新时间倒序', () => {
    const groups = groupMemories([
      memory({ id: 1, category: 'reference' }),
      memory({ id: 2, status: 'expired', updatedAt: 9 }),
      memory({ id: 3, updatedAt: 1 }),
      memory({ id: 4, status: 'disabled', updatedAt: 5 }),
      memory({ id: 5, updatedAt: 2 }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(['rule', 'reference']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([5, 3, 4, 2]);
  });
});
