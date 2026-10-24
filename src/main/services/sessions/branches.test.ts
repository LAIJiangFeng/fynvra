import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitRunner } from '../gitRepository';
import { BRANCH_REFRESH_THROTTLE_MS, createBranchTracker, readGitBranch } from './branches';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('readGitBranch（真实 git）', () => {
  let base: string;
  let previousCeiling: string | undefined;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-branch-')));
    // 临时目录若恰好在某个仓库里，git 会向上找到外层仓库；用天花板目录隔离
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
  });

  afterAll(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(base, { recursive: true, force: true });
  });

  const makeRepo = (name: string): string => {
    const repo = join(base, name);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
  };

  it('reads the checked-out branch, including one with a slash', async () => {
    const repo = makeRepo('plain');
    expect(await readGitBranch(repo)).toBe('main');
    git(repo, 'checkout', '-q', '-b', 'fynvra/add-tests');
    expect(await readGitBranch(repo)).toBe('fynvra/add-tests');
  });

  it('reads the branch of a linked worktree (a dispatched worker session)', async () => {
    const repo = makeRepo('with-worktree');
    const worktree = join(base, 'with-worktree-task');
    git(repo, 'worktree', 'add', '-q', '-b', 'fynvra/task', worktree);
    expect(await readGitBranch(worktree)).toBe('fynvra/task');
    expect(await readGitBranch(repo)).toBe('main');
  });

  it('gives the short sha of a detached HEAD', async () => {
    const repo = makeRepo('detached');
    git(repo, 'checkout', '-q', '--detach');
    const sha = git(repo, 'rev-parse', '--short', 'HEAD');
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(await readGitBranch(repo)).toBe(sha);
  });

  it('gives the branch of a repository that has no commit yet', async () => {
    const repo = join(base, 'unborn');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'trunk');
    expect(await readGitBranch(repo)).toBe('trunk');
  });

  it('gives nothing for a directory that is not a git repository, or does not exist', async () => {
    const plain = join(base, 'not-a-repo');
    mkdirSync(plain);
    expect(await readGitBranch(plain)).toBeUndefined();
    expect(await readGitBranch(join(base, 'removed-worktree'))).toBeUndefined();
  });
});

describe('readGitBranch（注入 runner）', () => {
  it('runs symbolic-ref first and rev-parse only for a detached HEAD', async () => {
    const calls: string[] = [];
    const run: GitRunner = async (args) => {
      calls.push(args.join(' '));
      return args[0] === 'symbolic-ref'
        ? { ok: false, error: '' }
        : { ok: true, stdout: 'a1b2c3d\n' };
    };
    expect(await readGitBranch('/repo', run)).toBe('a1b2c3d');
    expect(calls).toEqual(['symbolic-ref --quiet --short HEAD', 'rev-parse --short HEAD']);
  });

  it('gives up after the timeout instead of waiting on a stuck git', async () => {
    vi.useFakeTimers();
    try {
      const run: GitRunner = () => new Promise(() => {});
      const read = readGitBranch('/repo', run, 2_000);
      let settled = false;
      void read.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(read).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives nothing when git is missing', async () => {
    const run: GitRunner = async () => ({ ok: false, error: 'spawn git ENOENT', missingGit: true });
    expect(await readGitBranch('/repo', run)).toBeUndefined();
  });
});

describe('createBranchTracker', () => {
  function setup(branches: Record<string, string | undefined> = { '/repo': 'main' }) {
    let time = 10_000;
    const read = vi.fn(async (cwd: string) => branches[cwd]);
    const tracker = createBranchTracker({ read, now: () => time });
    return {
      tracker,
      read,
      branches,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  it('has nothing before the first read, then caches what it read and reports the change', async () => {
    const { tracker, read } = setup();
    expect(tracker.get('/repo')).toBeUndefined();
    expect(await tracker.refresh(['/repo'])).toEqual(['/repo']);
    expect(tracker.get('/repo')).toBe('main');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads a directory at most once per throttle window unless forced', async () => {
    const { tracker, read, branches, advance } = setup();
    await tracker.refresh(['/repo']);
    branches['/repo'] = 'feature';
    expect(await tracker.refresh(['/repo'])).toEqual([]);
    advance(BRANCH_REFRESH_THROTTLE_MS - 1);
    expect(await tracker.refresh(['/repo'])).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(tracker.get('/repo')).toBe('main');

    advance(1);
    expect(await tracker.refresh(['/repo'])).toEqual(['/repo']);
    expect(tracker.get('/repo')).toBe('feature');

    branches['/repo'] = 'hotfix';
    expect(await tracker.refresh(['/repo'], { force: true })).toEqual(['/repo']);
    expect(tracker.get('/repo')).toBe('hotfix');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not report a read that found the same branch, or no repository at all', async () => {
    const { tracker, advance } = setup({ '/repo': 'main', '/plain': undefined });
    expect(await tracker.refresh(['/repo', '/plain'])).toEqual(['/repo']);
    advance(BRANCH_REFRESH_THROTTLE_MS);
    expect(await tracker.refresh(['/repo', '/plain'])).toEqual([]);
    expect(tracker.get('/plain')).toBeUndefined();
  });

  it('reads a directory once when it is asked for several times at once', async () => {
    const { tracker, read } = setup();
    const [first, second] = await Promise.all([
      tracker.refresh(['/repo', '/repo']),
      tracker.refresh(['/repo']),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toEqual(['/repo']);
    expect(second).toEqual(['/repo']);
  });

  it('reads again after a pending read when forced, so a checkout during it is not missed', async () => {
    let finishFirst: (branch: string) => void = () => {};
    const read = vi
      .fn<(cwd: string) => Promise<string | undefined>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValue('feature');
    const tracker = createBranchTracker({ read, now: () => 0 });
    const listed = tracker.refresh(['/repo']);
    const settled = tracker.refresh(['/repo'], { force: true });
    finishFirst('main');
    expect(await listed).toEqual(['/repo']);
    expect(await settled).toEqual(['/repo']);
    expect(read).toHaveBeenCalledTimes(2);
    expect(tracker.get('/repo')).toBe('feature');
  });

  it('keeps the last branch when a read fails', async () => {
    const { tracker, read, advance } = setup();
    await tracker.refresh(['/repo']);
    read.mockRejectedValueOnce(new Error('boom'));
    advance(BRANCH_REFRESH_THROTTLE_MS);
    expect(await tracker.refresh(['/repo'])).toEqual([]);
    expect(tracker.get('/repo')).toBe('main');
  });

  it('lists the directories it has read, for a refresh of all of them', async () => {
    const { tracker } = setup({ '/repo': 'main', '/worktrees/a': 'fynvra/a' });
    expect(tracker.known()).toEqual([]);
    await tracker.refresh(['/repo', '/worktrees/a']);
    expect(tracker.known().sort()).toEqual(['/repo', '/worktrees/a']);
  });
});
