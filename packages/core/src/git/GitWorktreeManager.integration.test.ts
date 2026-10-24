import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../types';
import { type ExecFn, GitWorktreeManager } from './GitWorktreeManager';

const hasGit = spawnSync('git', ['--version']).status === 0;

// 与 Main 侧同样的 execFile 适配：非零退出码 resolve，进程起不来才 reject
const exec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      }
    );
  });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', message);
}

// 真实 git 仓库 + worktree，Windows 上较慢
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

describe.skipIf(!hasGit)('GitWorktreeManager（真实 git）', () => {
  const manager = new GitWorktreeManager({ exec });
  let root: string;
  let repo: string;
  let worktreesRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fynvra-git-'));
    repo = join(root, 'repo');
    worktreesRoot = join(root, 'worktrees');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'fynvra-test');
    git(repo, 'config', 'user.email', 'test@fynvra.invalid');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'commit.gpgsign', 'false');
    commitFile(repo, 'a.txt', 'base\n', 'init');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function create(slug: string): Promise<Worktree> {
    const result = await manager.create({
      repoPath: repo,
      workspaceId: 'ws_1',
      slug,
      baseRef: 'main',
      worktreesRoot,
    });
    if (!result.ok) throw new Error(result.error);
    return result.worktree;
  }

  it('create：从 baseRef 切出 fynvra/<slug>，检出到 <root>/<workspaceId>/<slug>', async () => {
    const worktree = await create('Add Parser');
    expect(worktree.branch).toBe('fynvra/add-parser');
    expect(worktree.path).toBe(join(worktreesRoot, 'ws_1', 'add-parser'));
    expect(worktree.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(worktree.path, 'a.txt'))).toBe(true);
    expect(git(worktree.path, 'branch', '--show-current')).toBe('fynvra/add-parser');
  });

  it('分支冲突追加 -2、-3；并发 create 不会抢到同一个名字', async () => {
    const first = await create('dup');
    const [second, third] = await Promise.all([create('dup'), create('dup')]);
    expect([first.branch, second.branch, third.branch]).toEqual([
      'fynvra/dup',
      'fynvra/dup-2',
      'fynvra/dup-3',
    ]);
    expect(new Set([first.path, second.path, third.path]).size).toBe(3);
  });

  it('目标目录已被占用时返回错误，且不留下 git 先建出的分支', async () => {
    const busy = join(worktreesRoot, 'ws_1', 'busy');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'leftover.txt'), 'x');
    const result = await manager.create({
      repoPath: repo,
      workspaceId: 'ws_1',
      slug: 'busy',
      baseRef: 'main',
      worktreesRoot,
    });
    expect(result.ok).toBe(false);
    expect(git(repo, 'branch', '--list', 'fynvra/busy')).toBe('');
  });

  it('status：未提交改动 → dirty；worktree 提交 → ahead；主分支前进 → behind', async () => {
    const worktree = await create('status');
    expect(await manager.status(worktree)).toEqual({
      ok: true,
      status: { dirty: false, ahead: 0, behind: 0 },
    });
    writeFileSync(join(worktree.path, 'b.txt'), 'new\n');
    const dirty = await manager.status(worktree);
    expect(dirty.ok && dirty.status.dirty).toBe(true);

    git(worktree.path, 'add', '.');
    git(worktree.path, 'commit', '-q', '-m', 'work');
    commitFile(repo, 'c.txt', 'main moved\n', 'main moves on');
    expect(await manager.status(worktree)).toEqual({
      ok: true,
      status: { dirty: false, ahead: 1, behind: 1 },
    });
  });

  it('status：worktree 目录不存在时返回错误（exec reject 被收住）', async () => {
    const worktree = await create('gone');
    rmSync(worktree.path, { recursive: true, force: true });
    const result = await manager.status(worktree);
    expect(result.ok).toBe(false);
  });

  it('diff：只含已提交的改动，文件名不转义', async () => {
    const worktree = await create('diff');
    commitFile(worktree.path, '说明.md', 'hello\n', 'add notes');
    writeFileSync(join(worktree.path, 'uncommitted.txt'), 'not yet');
    const result = await manager.diff(worktree);
    expect(result.ok && result.files).toEqual(['说明.md']);
    expect(result.ok && result.patch).toContain('+hello');
    expect(result.ok && result.patch).toContain('b/说明.md');
  });

  it('merge：--no-ff 生成双亲合并提交并返回其 sha', async () => {
    const worktree = await create('merge-ok');
    commitFile(worktree.path, 'b.txt', 'feature\n', 'feature');
    const result = await manager.merge({ repoPath: repo, branch: worktree.branch });
    expect(result).toEqual({ ok: true, commit: git(repo, 'rev-parse', 'HEAD') });
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(existsSync(join(repo, 'b.txt'))).toBe(true);
  });

  it('merge 冲突：返回冲突文件，自动 abort，主仓库回到合并前', async () => {
    const worktree = await create('merge-conflict');
    commitFile(worktree.path, 'a.txt', 'from worktree\n', 'worktree edit');
    commitFile(repo, 'a.txt', 'from main\n', 'main edit');
    const before = git(repo, 'rev-parse', 'HEAD');

    const result = await manager.merge({ repoPath: repo, branch: worktree.branch });
    expect(result).toEqual({
      ok: false,
      conflicts: ['a.txt'],
      error: expect.stringContaining('merge aborted'),
    });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('remove / deleteBranch：默认拒绝不干净的 worktree 与未合并分支，force 后清理干净', async () => {
    const worktree = await create('cleanup');
    commitFile(worktree.path, 'b.txt', 'x\n', 'work');
    writeFileSync(join(worktree.path, 'scratch.txt'), 'untracked');

    expect((await manager.remove({ repoPath: repo, path: worktree.path })).ok).toBe(false);
    expect(await manager.remove({ repoPath: repo, path: worktree.path, force: true })).toEqual({
      ok: true,
    });
    expect(existsSync(worktree.path)).toBe(false);

    expect((await manager.deleteBranch({ repoPath: repo, branch: worktree.branch })).ok).toBe(
      false
    );
    expect(
      await manager.deleteBranch({ repoPath: repo, branch: worktree.branch, force: true })
    ).toEqual({ ok: true });
    expect(git(repo, 'branch', '--list', worktree.branch)).toBe('');
  });

  it('合并后的分支可以用默认的 -d 删除', async () => {
    const worktree = await create('merged');
    commitFile(worktree.path, 'b.txt', 'x\n', 'work');
    expect((await manager.merge({ repoPath: repo, branch: worktree.branch })).ok).toBe(true);
    expect(await manager.remove({ repoPath: repo, path: worktree.path })).toEqual({ ok: true });
    expect(await manager.deleteBranch({ repoPath: repo, branch: worktree.branch })).toEqual({
      ok: true,
    });
  });

  it('prune：清理目录已被手动删除的 worktree 登记', async () => {
    const worktree = await create('pruned');
    rmSync(worktree.path, { recursive: true, force: true });
    expect(await manager.prune(repo)).toEqual({ ok: true });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('pruned');
  });
});
