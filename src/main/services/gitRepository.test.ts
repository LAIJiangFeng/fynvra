import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GitRunner, inspectGitRepository, samePath } from './gitRepository';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('inspectGitRepository（真实 git）', () => {
  let base: string;
  let previousCeiling: string | undefined;

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-git-')));
    // 宿主机临时目录若恰好位于某个仓库内，git 会向上找到外层仓库；用天花板目录隔离
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
  });

  afterAll(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(base, { recursive: true, force: true });
  });

  const makeRepo = (name: string, branch: string): string => {
    const repo = join(base, name);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo });
    return repo;
  };

  it('非 git 目录被拒绝', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await inspectGitRepository(plain)).toMatchObject({ ok: false, code: 'not-git-repo' });
  });

  it('仓库根目录通过：名称取目录名，无远端且无 main/master 时取当前分支', async () => {
    const repo = makeRepo('my-repo', 'trunk');
    expect(await inspectGitRepository(repo)).toEqual({
      ok: true,
      root: repo,
      name: 'my-repo',
      defaultBranch: 'trunk',
    });
  });

  it('仓库子目录被拒绝，并指出仓库根目录', async () => {
    const repo = makeRepo('nested-repo', 'main');
    const sub = join(repo, 'src');
    mkdirSync(sub);
    const result = await inspectGitRepository(sub);
    expect(result).toMatchObject({ ok: false, code: 'not-repo-root' });
    expect(!result.ok && result.error).toContain(repo);
  });

  it('不存在的目录返回 failed', async () => {
    expect(await inspectGitRepository(join(base, 'missing'))).toMatchObject({
      ok: false,
      code: 'failed',
    });
  });
});

describe('inspectGitRepository（注入 runner）', () => {
  const root = realpathSync.native(tmpdir());

  const runner =
    (replies: Record<string, string | null>): GitRunner =>
    async (args) => {
      const reply = replies[args.join(' ')];
      return typeof reply === 'string'
        ? { ok: true, stdout: `${reply}\n` }
        : { ok: false, error: `fatal: ${args.join(' ')}` };
    };

  it('找不到 git 可执行文件时返回 git-unavailable', async () => {
    const run: GitRunner = async () => ({ ok: false, error: 'spawn git ENOENT', missingGit: true });
    expect(await inspectGitRepository(root, run)).toMatchObject({
      ok: false,
      code: 'git-unavailable',
    });
  });

  it('优先使用 origin/HEAD 指向的分支', async () => {
    const run = runner({
      'rev-parse --show-toplevel': root,
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/develop',
    });
    expect(await inspectGitRepository(root, run)).toMatchObject({
      ok: true,
      defaultBranch: 'develop',
    });
  });

  it('无远端时依次尝试本地 main、master，再退回当前分支', async () => {
    const base = { 'rev-parse --show-toplevel': root };
    const masterOnly = runner({
      ...base,
      'rev-parse --verify --quiet refs/heads/master': 'abc123',
      'symbolic-ref --quiet --short HEAD': 'feature/x',
    });
    expect(await inspectGitRepository(root, masterOnly)).toMatchObject({ defaultBranch: 'master' });

    const detached = runner(base);
    expect(await inspectGitRepository(root, detached)).toMatchObject({ defaultBranch: 'main' });
  });
});

describe('samePath', () => {
  it('Windows 下忽略大小写，其他平台区分大小写', () => {
    expect(samePath('C:\\Repos\\Fynvra', 'c:\\repos\\fynvra', 'win32')).toBe(true);
    expect(samePath('/repos/Fynvra', '/repos/fynvra', 'linux')).toBe(false);
    expect(samePath('/repos/fynvra', '/repos/fynvra', 'darwin')).toBe(true);
  });
});
