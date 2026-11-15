import { existsSync, mkdirSync, mkdtempSync, promises, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergedCleanupBlocker, removeTree } from './worktreeCleanup';

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

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe('removeTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('EBUSY 是暂时的：重试到成功', async () => {
    vi.useFakeTimers();
    const rm = vi
      .spyOn(promises, 'rm')
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockResolvedValue(undefined);
    const done = removeTree('x');
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it('非暂时错误不重试', async () => {
    const rm = vi.spyOn(promises, 'rm').mockRejectedValue(fsError('EACCES'));
    await expect(removeTree('x')).rejects.toThrow('EACCES');
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('一直 EBUSY：约 5 秒后放弃', async () => {
    vi.useFakeTimers();
    const rm = vi.spyOn(promises, 'rm').mockRejectedValue(fsError('EBUSY'));
    const done = removeTree('x');
    const settled = expect(done).rejects.toThrow('EBUSY');
    await vi.advanceTimersByTimeAsync(6000);
    await settled;
    expect(rm.mock.calls.length).toBeGreaterThan(10);
    expect(rm.mock.calls.length).toBeLessThan(25);
  });

  it('删掉嵌套目录；路径不存在时也成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-remove-tree-'));
    try {
      const deep = join(dir, 'wt', 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'default_app.asar'), 'asar');
      await removeTree(join(dir, 'wt'));
      expect(existsSync(join(dir, 'wt'))).toBe(false);
      await expect(removeTree(join(dir, 'missing'))).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
