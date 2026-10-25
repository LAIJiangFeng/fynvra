import { describe, expect, it } from 'vitest';
import { mergedCleanupBlocker } from './worktreeCleanup';

const clean = { dirty: false, ahead: 0, behind: 3 };

describe('mergedCleanupBlocker（归档时能不能删 worker 的 worktree）', () => {
  it('合并过、干净、没有合并之后的新提交：可以删（基准前进了不影响）', () => {
    expect(mergedCleanupBlocker('completed', clean)).toBeNull();
    expect(mergedCleanupBlocker('completed', { ...clean, behind: 0 })).toBeNull();
  });

  it.each([
    ['todo'],
    ['in-progress'],
    ['in-review'],
    ['failed'],
    ['abandoned'],
    [undefined],
  ] as const)('任务状态 %s：没经 merge_worktree 合并，不删', (status) => {
    expect(mergedCleanupBlocker(status, clean)).toBe('not-merged');
  });

  it('有未提交改动或未跟踪文件：不删', () => {
    expect(mergedCleanupBlocker('completed', { ...clean, dirty: true })).toBe('dirty');
  });

  it('合并之后 worker 又提交了：不删', () => {
    expect(mergedCleanupBlocker('completed', { ...clean, ahead: 1 })).toBe('unmerged-commits');
    expect(mergedCleanupBlocker('completed', { dirty: true, ahead: 2, behind: 0 })).toBe('dirty');
  });
});
