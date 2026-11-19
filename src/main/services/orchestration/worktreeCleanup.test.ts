import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  promises,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergedCleanupBlocker, removeTree, unlinkLinksIn } from './worktreeCleanup';

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

  it('带 PR 的任务：HEAD 必须正好等于已推送提交（相对它 ahead / behind 都为 0）', () => {
    const pushed = { dirty: false, ahead: 0, behind: 0 };
    expect(mergedCleanupBlocker('completed', pushed, true)).toBeNull();
    expect(mergedCleanupBlocker('completed', { ...pushed, ahead: 1 }, true)).toBe(
      'unmerged-commits'
    );
    expect(mergedCleanupBlocker('completed', { ...pushed, behind: 1 }, true)).toBe(
      'unmerged-commits'
    );
    expect(mergedCleanupBlocker('completed', { ...pushed, dirty: true }, true)).toBe('dirty');
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

describe('unlinkLinksIn', () => {
  let base: string;
  let wt: string;
  let outside: string;
  // Windows 上建 junction 不需要管理员权限；POSIX 忽略类型参数
  const link = (target: string, path: string) => symlinkSync(target, path, 'junction');
  const linkExists = (path: string) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'fynvra-unlink-'));
    wt = join(base, 'wt');
    outside = join(base, 'outside');
    mkdirSync(join(wt, 'pkg', 'inner'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'x');
    writeFileSync(join(wt, 'pkg', 'inner', 'a.txt'), 'a');
    link(outside, join(wt, 'pkg', 'out'));
    link(join(wt, 'pkg', 'inner'), join(wt, 'in'));
    link(wt, join(wt, 'self'));
    const gone = join(base, 'gone');
    mkdirSync(gone);
    link(gone, join(wt, 'dangling'));
    rmSync(gone, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('keepInside：删指向外部 / 根本身 / 悬空的链接，保留指向内部的；真实目录递归处理且不删', async () => {
    await unlinkLinksIn(wt, { keepInside: wt });
    expect(linkExists(join(wt, 'pkg', 'out'))).toBe(false);
    expect(linkExists(join(wt, 'self'))).toBe(false);
    expect(linkExists(join(wt, 'dangling'))).toBe(false);
    expect(linkExists(join(wt, 'in'))).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(join(wt, 'pkg', 'inner', 'a.txt'))).toBe(true);
  });

  it('不带参数：所有链接都删，目标文件保留', async () => {
    await unlinkLinksIn(wt);
    for (const name of [join('pkg', 'out'), 'in', 'self', 'dangling']) {
      expect(linkExists(join(wt, name))).toBe(false);
    }
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(join(wt, 'pkg', 'inner', 'a.txt'))).toBe(true);
  });
});
