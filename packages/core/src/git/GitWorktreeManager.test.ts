import { describe, expect, it } from 'vitest';
import type { Worktree } from '../types';
import { type ExecFn, GitWorktreeManager, normalizeSlug } from './GitWorktreeManager';

interface Step {
  args: string[];
  cwd: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** 按顺序回放脚本化的 git 结果，并记录实际调用；断言放在测试里（exec 内抛错会被被测代码吞掉）。 */
function scriptedGit(steps: Step[], removeDir?: (path: string) => Promise<void>) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const exec: ExecFn = async (cmd, args, cwd) => {
    calls.push({ cmd, args: [...args], cwd });
    const step = steps[calls.length - 1];
    if (step === undefined) return { code: 99, stdout: '', stderr: 'unexpected git call' };
    return { code: step.code ?? 0, stdout: step.stdout ?? '', stderr: step.stderr ?? '' };
  };
  // 每条命令都带 -c core.longpaths=true（Windows 长路径）
  const expected = () =>
    steps.map(({ args, cwd }) => ({ cmd: 'git', args: [...LONGPATHS, ...args], cwd }));
  return { manager: new GitWorktreeManager({ exec, removeDir }), calls, expected };
}

const LONGPATHS = ['-c', 'core.longpaths=true'];
const REPO = '/repo';
const ROOT = '/data/worktrees';
const BASE = 'abc1230000000000000000000000000000000000';
const resolveBase = (ref = 'main'): Step => ({
  args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
  cwd: REPO,
  stdout: `${BASE}\n`,
});
const listBranches = (...branches: string[]): Step => ({
  args: ['for-each-ref', '--format=%(refname)', 'refs/heads/fynvra/'],
  cwd: REPO,
  stdout: branches.map((branch) => `refs/heads/${branch}\n`).join(''),
});
const addWorktree = (branch: string, path: string, extra: Partial<Step> = {}): Step => ({
  args: ['worktree', 'add', '--quiet', '-b', branch, '--', path, BASE],
  cwd: REPO,
  ...extra,
});
const createInput = {
  repoPath: REPO,
  workspaceId: 'ws_1',
  slug: 'Add parser',
  baseRef: 'main',
  worktreesRoot: ROOT,
};

const worktree: Worktree = {
  id: 'wt_1',
  workspaceId: 'ws_1',
  path: '/data/worktrees/ws_1/add-parser',
  branch: 'fynvra/add-parser',
  baseRef: 'main',
  baseCommit: BASE,
};

describe('normalizeSlug', () => {
  it.each([
    ['Add JSON Parser!! (v2)', 'add-json-parser-v2'],
    ['  --Fix   login--  ', 'fix-login'],
    ['Café crème', 'cafe-creme'],
    ['修复登录', 'task'],
    ['', 'task'],
    ['a'.repeat(50), 'a'.repeat(40)],
    [`${'ab-'.repeat(13)}cd`, `${'ab-'.repeat(13)}c`],
    [`${'x'.repeat(39)}-tail`, 'x'.repeat(39)],
  ])('%j → %j', (input, expected) => {
    const slug = normalizeSlug(input);
    expect(slug).toBe(expected);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe('GitWorktreeManager.create', () => {
  it('解析 baseRef → 查已有 fynvra/* 分支 → worktree add -b fynvra/<slug> <root>/<workspaceId>/<slug>', async () => {
    const git = scriptedGit([
      resolveBase(),
      listBranches(),
      addWorktree('fynvra/add-parser', '/data/worktrees/ws_1/add-parser'),
    ]);
    const result = await git.manager.create(createInput);
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({
      ok: true,
      worktree: { ...worktree, id: expect.stringMatching(/^wt_/) },
    });
  });

  it('Windows 根目录沿用反斜杠拼路径', async () => {
    const path = 'C:\\fynvra\\worktrees\\ws_1\\add-parser';
    const git = scriptedGit([
      resolveBase(),
      listBranches(),
      addWorktree('fynvra/add-parser', path),
    ]);
    const result = await git.manager.create({
      ...createInput,
      worktreesRoot: 'C:\\fynvra\\worktrees',
    });
    expect(git.calls).toEqual(git.expected());
    expect(result.ok && result.worktree.path).toBe(path);
  });

  it('分支冲突时追加 -2、-3 直到可用', async () => {
    const git = scriptedGit([
      resolveBase(),
      listBranches('fynvra/add-parser', 'fynvra/add-parser-2', 'fynvra/other'),
      addWorktree('fynvra/add-parser-3', '/data/worktrees/ws_1/add-parser-3'),
    ]);
    const result = await git.manager.create(createInput);
    expect(git.calls).toEqual(git.expected());
    expect(result.ok && result.worktree.branch).toBe('fynvra/add-parser-3');
  });

  it('加后缀后 slug 仍不超过 40 字符', async () => {
    const long = 'a'.repeat(40);
    const suffixed = `${'a'.repeat(38)}-2`;
    const git = scriptedGit([
      resolveBase(),
      listBranches(`fynvra/${long}`),
      addWorktree(`fynvra/${suffixed}`, `/data/worktrees/ws_1/${suffixed}`),
    ]);
    const result = await git.manager.create({ ...createInput, slug: 'a'.repeat(55) });
    expect(git.calls).toEqual(git.expected());
    expect(result.ok && result.worktree.branch).toBe(`fynvra/${suffixed}`);
  });

  it('baseRef 解析不到提交时返回错误，不再继续', async () => {
    const git = scriptedGit([{ ...resolveBase('nope'), code: 1, stdout: '' }]);
    const result = await git.manager.create({ ...createInput, baseRef: 'nope' });
    expect(git.calls).toEqual(git.expected());
    expect(!result.ok && result.error).toMatch(/base ref "nope"/);
  });

  it('worktree add 失败：删掉 git 已经建出来的分支，返回 git 的错误', async () => {
    const git = scriptedGit([
      resolveBase(),
      listBranches(),
      addWorktree('fynvra/add-parser', '/data/worktrees/ws_1/add-parser', {
        code: 128,
        stderr: "fatal: '/data/worktrees/ws_1/add-parser' already exists\n",
      }),
      {
        args: ['rev-parse', '--verify', '--quiet', 'refs/heads/fynvra/add-parser'],
        cwd: REPO,
        stdout: `${BASE}\n`,
      },
      { args: ['branch', '-D', 'fynvra/add-parser'], cwd: REPO },
    ]);
    const result = await git.manager.create(createInput);
    expect(git.calls).toEqual(git.expected());
    expect(!result.ok && result.error).toMatch(/already exists/);
  });

  it('worktree add 失败且分支未建出（或已指向别处）时不删分支', async () => {
    const git = scriptedGit([
      resolveBase(),
      listBranches(),
      addWorktree('fynvra/add-parser', '/data/worktrees/ws_1/add-parser', { code: 128 }),
      {
        args: ['rev-parse', '--verify', '--quiet', 'refs/heads/fynvra/add-parser'],
        cwd: REPO,
        code: 1,
      },
    ]);
    const result = await git.manager.create(createInput);
    expect(git.calls).toEqual(git.expected());
    expect(result.ok).toBe(false);
  });

  it.each([
    ['workspaceId 含路径分隔符', { workspaceId: '../escape' }, /workspaceId/],
    ['workspaceId 为空', { workspaceId: '' }, /workspaceId/],
    ['baseRef 以 - 开头（参数注入）', { baseRef: '--upload-pack=evil' }, /baseRef/],
    ['baseRef 含空白', { baseRef: 'main branch' }, /baseRef/],
  ])('非法入参（%s）不调用 git', async (_label, override, error) => {
    const git = scriptedGit([]);
    const result = await git.manager.create({ ...createInput, ...override });
    expect(git.calls).toEqual([]);
    expect(!result.ok && result.error).toMatch(error);
  });

  it('exec 本身 reject（git 不存在）时返回错误而不是抛异常', async () => {
    const manager = new GitWorktreeManager({
      exec: async () => {
        throw new Error('spawn git ENOENT');
      },
    });
    const result = await manager.create(createInput);
    expect(!result.ok && result.error).toMatch(/ENOENT/);
  });

  it('某次 create 意外出错不会卡死后续调用（排队链不被污染）', async () => {
    const git = scriptedGit([
      resolveBase(),
      listBranches(),
      addWorktree('fynvra/add-parser', '/data/worktrees/ws_1/add-parser'),
    ]);
    const broken = await git.manager.create({
      ...createInput,
      slug: undefined as unknown as string,
    });
    expect(broken.ok).toBe(false);
    git.calls.length = 0;
    const result = await git.manager.create(createInput);
    expect(result.ok).toBe(true);
  });

  it('候选名全部被占用时返回错误', async () => {
    const taken = ['fynvra/add-parser'];
    for (let n = 2; n <= 99; n++) taken.push(`fynvra/add-parser-${n}`);
    const git = scriptedGit([resolveBase(), listBranches(...taken)]);
    const result = await git.manager.create(createInput);
    expect(git.calls).toEqual(git.expected());
    expect(!result.ok && result.error).toMatch(/no free branch name/);
  });
});

describe('GitWorktreeManager.status', () => {
  it('dirty 来自 status --porcelain，ahead / behind 相对 baseRef 当前位置', async () => {
    const git = scriptedGit([
      { args: ['status', '--porcelain'], cwd: worktree.path, stdout: ' M src/a.ts\n?? b.ts\n' },
      {
        args: ['rev-parse', '--verify', '--quiet', 'main^{commit}'],
        cwd: worktree.path,
        stdout: 'def456\n',
      },
      {
        args: ['rev-list', '--left-right', '--count', 'def456...HEAD'],
        cwd: worktree.path,
        stdout: '2\t3\n',
      },
    ]);
    const result = await git.manager.status(worktree);
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({ ok: true, status: { dirty: true, ahead: 3, behind: 2 } });
  });

  it('baseRef 已不存在时回退到 baseCommit', async () => {
    const git = scriptedGit([
      { args: ['status', '--porcelain'], cwd: worktree.path },
      { args: ['rev-parse', '--verify', '--quiet', 'main^{commit}'], cwd: worktree.path, code: 1 },
      {
        args: ['rev-list', '--left-right', '--count', `${BASE}...HEAD`],
        cwd: worktree.path,
        stdout: '0\t1\n',
      },
    ]);
    const result = await git.manager.status(worktree);
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({ ok: true, status: { dirty: false, ahead: 1, behind: 0 } });
  });

  it('worktree 目录不可用时返回错误', async () => {
    const git = scriptedGit([
      {
        args: ['status', '--porcelain'],
        cwd: worktree.path,
        code: 128,
        stderr: 'fatal: not a git repository',
      },
    ]);
    const result = await git.manager.status(worktree);
    expect(!result.ok && result.error).toMatch(/not a git repository/);
  });
});

describe('GitWorktreeManager.diff', () => {
  it('列出 base...HEAD 的改动文件与补丁（默认 base = worktree.baseCommit）', async () => {
    const range = `${BASE}...HEAD`;
    const git = scriptedGit([
      {
        args: ['diff', '--name-only', '-z', range],
        cwd: worktree.path,
        stdout: 'src/a.ts\0文档.md\0',
      },
      {
        args: ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', range],
        cwd: worktree.path,
        stdout: 'diff --git a/src/a.ts b/src/a.ts\n+x\n',
      },
    ]);
    const result = await git.manager.diff(worktree);
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({
      ok: true,
      files: ['src/a.ts', '文档.md'],
      patch: 'diff --git a/src/a.ts b/src/a.ts\n+x\n',
    });
  });

  it('可以指定别的 baseCommit', async () => {
    const git = scriptedGit([
      { args: ['diff', '--name-only', '-z', 'main...HEAD'], cwd: worktree.path },
      {
        args: ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', 'main...HEAD'],
        cwd: worktree.path,
      },
    ]);
    expect(await git.manager.diff(worktree, 'main')).toEqual({ ok: true, files: [], patch: '' });
    expect(git.calls).toEqual(git.expected());
  });

  it('在主仓库用指定 worker ref 读取差异，不读主仓库 HEAD', async () => {
    const range = `${BASE}...refs/heads/fynvra/add-parser`;
    const git = scriptedGit([
      { args: ['diff', '--name-only', '-z', range], cwd: REPO, stdout: 'worker.ts\0' },
      {
        args: ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', range],
        cwd: REPO,
        stdout: '+worker change\n',
      },
    ]);
    expect(
      await git.manager.diff({ path: REPO, baseCommit: BASE }, BASE, 'refs/heads/fynvra/add-parser')
    ).toEqual({ ok: true, files: ['worker.ts'], patch: '+worker change\n' });
    expect(git.calls).toEqual(git.expected());
  });

  it.each(['', '--output=/tmp/x', 'HEAD\n--stat'])('拒绝非法 headRef %j', async (headRef) => {
    const git = scriptedGit([]);
    expect(await git.manager.diff(worktree, BASE, headRef)).toMatchObject({ ok: false });
    expect(git.calls).toEqual([]);
  });

  it('拒绝以 - 开头的 baseCommit', async () => {
    const git = scriptedGit([]);
    const result = await git.manager.diff(worktree, '--output=/tmp/x');
    expect(git.calls).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe('GitWorktreeManager.merge', () => {
  it('git merge --no-ff --no-edit 成功后返回合并提交', async () => {
    const git = scriptedGit([
      { args: ['merge', '--no-ff', '--no-edit', 'fynvra/add-parser'], cwd: REPO },
      { args: ['rev-parse', 'HEAD'], cwd: REPO, stdout: 'merge789\n' },
    ]);
    const result = await git.manager.merge({ repoPath: REPO, branch: 'fynvra/add-parser' });
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({ ok: true, commit: 'merge789' });
  });

  it('冲突：列出冲突文件并 merge --abort', async () => {
    const git = scriptedGit([
      {
        args: ['merge', '--no-ff', '--no-edit', 'fynvra/add-parser'],
        cwd: REPO,
        code: 1,
        stdout: 'CONFLICT (content): Merge conflict in a.txt\n',
      },
      {
        args: ['diff', '--name-only', '-z', '--diff-filter=U'],
        cwd: REPO,
        stdout: 'a.txt\0dir/b.txt\0',
      },
      { args: ['merge', '--abort'], cwd: REPO },
    ]);
    const result = await git.manager.merge({ repoPath: REPO, branch: 'fynvra/add-parser' });
    expect(git.calls).toEqual(git.expected());
    expect(result).toEqual({
      ok: false,
      conflicts: ['a.txt', 'dir/b.txt'],
      error: expect.stringMatching(/conflict.*2 file.*aborted/i),
    });
  });

  it('非冲突失败（如分支不存在）：返回 git 的错误，不带 conflicts', async () => {
    const git = scriptedGit([
      {
        args: ['merge', '--no-ff', '--no-edit', 'fynvra/missing'],
        cwd: REPO,
        code: 1,
        stderr: 'merge: fynvra/missing - not something we can merge\n',
      },
      { args: ['diff', '--name-only', '-z', '--diff-filter=U'], cwd: REPO },
      {
        args: ['merge', '--abort'],
        cwd: REPO,
        code: 128,
        stderr: 'fatal: There is no merge to abort',
      },
    ]);
    const result = await git.manager.merge({ repoPath: REPO, branch: 'fynvra/missing' });
    expect(git.calls).toEqual(git.expected());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/not something we can merge/);
    expect(!result.ok && result.conflicts).toBeUndefined();
  });

  it.each(['--abort', '-n', 'a b', ''])('拒绝可疑分支名 %j', async (branch) => {
    const git = scriptedGit([]);
    const result = await git.manager.merge({ repoPath: REPO, branch });
    expect(git.calls).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe('GitWorktreeManager.remove / prune / deleteBranch', () => {
  it('remove 默认不强删；force 时加 --force；路径前加 -- 防参数注入', async () => {
    const git = scriptedGit([
      { args: ['worktree', 'remove', '--', worktree.path], cwd: REPO },
      { args: ['worktree', 'remove', '--force', '--', worktree.path], cwd: REPO },
    ]);
    expect(await git.manager.remove({ repoPath: REPO, path: worktree.path })).toEqual({ ok: true });
    expect(await git.manager.remove({ repoPath: REPO, path: worktree.path, force: true })).toEqual({
      ok: true,
    });
    expect(git.calls).toEqual(git.expected());
    expect(git.calls[0]?.args.slice(0, 2)).toEqual(['-c', 'core.longpaths=true']);
  });

  it('remove 失败（有未提交改动）返回 git 的错误', async () => {
    const git = scriptedGit([
      {
        args: ['worktree', 'remove', '--', worktree.path],
        cwd: REPO,
        code: 128,
        stderr: 'fatal: contains modified or untracked files, use --force to delete it',
      },
    ]);
    const result = await git.manager.remove({ repoPath: REPO, path: worktree.path });
    expect(!result.ok && result.error).toMatch(/--force/);
  });

  const listing = (...paths: string[]) =>
    paths.map((path) => `worktree ${path}\nHEAD ${BASE}\nbranch refs/heads/x\n\n`).join('');
  const tooLong = {
    code: 255,
    stderr: `error: failed to delete '${worktree.path}': Filename too long`,
  };

  it('git 删除失败（Filename too long）时兜底：删目录 → prune → 确认已注销', async () => {
    const removed: string[] = [];
    const git = scriptedGit(
      [
        { args: ['worktree', 'remove', '--force', '--', worktree.path], cwd: REPO, ...tooLong },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: REPO,
          stdout: listing(REPO, worktree.path),
        },
        { args: ['worktree', 'prune'], cwd: REPO },
        { args: ['worktree', 'list', '--porcelain'], cwd: REPO, stdout: listing(REPO) },
      ],
      async (path) => {
        removed.push(path);
      }
    );
    const result = await git.manager.remove({ repoPath: REPO, path: worktree.path, force: true });
    expect(result).toEqual({ ok: true });
    expect(removed).toEqual([worktree.path]);
    expect(git.calls).toEqual(git.expected());
  });

  it('兜底按 Windows 路径比较（分隔符、大小写）', async () => {
    const winPath = 'D:\\wt\\ws_1\\add-parser';
    const removed: string[] = [];
    const git = scriptedGit(
      [
        { args: ['worktree', 'remove', '--force', '--', winPath], cwd: 'D:\\repo', ...tooLong },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: 'D:\\repo',
          stdout: listing('D:/repo', 'd:/wt/ws_1/add-parser'),
        },
        { args: ['worktree', 'prune'], cwd: 'D:\\repo' },
        { args: ['worktree', 'list', '--porcelain'], cwd: 'D:\\repo', stdout: listing('D:/repo') },
      ],
      async (path) => {
        removed.push(path);
      }
    );
    const result = await git.manager.remove({ repoPath: 'D:\\repo', path: winPath, force: true });
    expect(result).toEqual({ ok: true });
    expect(removed).toEqual([winPath]);
  });

  it('非 force 且 worktree 有改动：不走兜底，返回 git 的拒绝', async () => {
    const removed: string[] = [];
    const git = scriptedGit(
      [
        {
          args: ['worktree', 'remove', '--', worktree.path],
          cwd: REPO,
          code: 128,
          stderr: 'fatal: contains modified or untracked files, use --force to delete it',
        },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: REPO,
          stdout: listing(REPO, worktree.path),
        },
        { args: ['status', '--porcelain'], cwd: worktree.path, stdout: '?? notes.md\n' },
      ],
      async (path) => {
        removed.push(path);
      }
    );
    const result = await git.manager.remove({ repoPath: REPO, path: worktree.path });
    expect(!result.ok && result.error).toMatch(/--force/);
    expect(removed).toEqual([]);
    expect(git.calls).toEqual(git.expected());
  });

  it('非 force 且 git status 确认干净：文件系统错误走兜底', async () => {
    const removed: string[] = [];
    const git = scriptedGit(
      [
        { args: ['worktree', 'remove', '--', worktree.path], cwd: REPO, ...tooLong },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: REPO,
          stdout: listing(REPO, worktree.path),
        },
        { args: ['status', '--porcelain'], cwd: worktree.path },
        { args: ['worktree', 'prune'], cwd: REPO },
        { args: ['worktree', 'list', '--porcelain'], cwd: REPO, stdout: listing(REPO) },
      ],
      async (path) => {
        removed.push(path);
      }
    );
    expect(await git.manager.remove({ repoPath: REPO, path: worktree.path })).toEqual({ ok: true });
    expect(removed).toEqual([worktree.path]);
    expect(git.calls).toEqual(git.expected());
  });

  it.each([
    ['未登记的路径', worktree.path, listing(REPO, '/data/worktrees/ws_1/other')],
    ['主 worktree', REPO, listing(REPO)],
    ['根目录', '/', listing(REPO, '/')],
    ['含主仓库的目录', '/data/x', listing('/data/x/repo', '/data/x')],
  ])('兜底不删%s', async (_label, path, stdout) => {
    const removed: string[] = [];
    const repoPath = path === '/data/x' ? '/data/x/repo' : REPO;
    const git = scriptedGit(
      [
        { args: ['worktree', 'remove', '--force', '--', path], cwd: repoPath, ...tooLong },
        { args: ['worktree', 'list', '--porcelain'], cwd: repoPath, stdout },
      ],
      async (dir) => {
        removed.push(dir);
      }
    );
    const result = await git.manager.remove({ repoPath, path, force: true });
    expect(!result.ok && result.error).toMatch(/Filename too long/);
    expect(removed).toEqual([]);
  });

  it('删目录后仍在登记列表里：返回失败', async () => {
    const git = scriptedGit(
      [
        { args: ['worktree', 'remove', '--force', '--', worktree.path], cwd: REPO, ...tooLong },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: REPO,
          stdout: listing(REPO, worktree.path),
        },
        { args: ['worktree', 'prune'], cwd: REPO },
        {
          args: ['worktree', 'list', '--porcelain'],
          cwd: REPO,
          stdout: listing(REPO, worktree.path),
        },
      ],
      async () => {}
    );
    const result = await git.manager.remove({ repoPath: REPO, path: worktree.path, force: true });
    expect(!result.ok && result.error).toMatch(/still registered/);
  });

  it('prune 执行 git worktree prune', async () => {
    const git = scriptedGit([{ args: ['worktree', 'prune'], cwd: REPO }]);
    expect(await git.manager.prune(REPO)).toEqual({ ok: true });
    expect(git.calls).toEqual(git.expected());
  });

  it('deleteBranch 默认 -d（只删已合并），force 时 -D；拒绝可疑分支名', async () => {
    const git = scriptedGit([
      { args: ['branch', '-d', 'fynvra/add-parser'], cwd: REPO },
      { args: ['branch', '-D', 'fynvra/add-parser'], cwd: REPO },
    ]);
    expect(await git.manager.deleteBranch({ repoPath: REPO, branch: 'fynvra/add-parser' })).toEqual(
      {
        ok: true,
      }
    );
    expect(
      await git.manager.deleteBranch({ repoPath: REPO, branch: 'fynvra/add-parser', force: true })
    ).toEqual({ ok: true });
    const bad = await git.manager.deleteBranch({ repoPath: REPO, branch: '-D' });
    expect(bad.ok).toBe(false);
    expect(git.calls).toEqual(git.expected());
  });
});
