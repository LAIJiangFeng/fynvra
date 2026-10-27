import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace, Worktree } from '@fynvra/core';
import type { SessionSummary } from '@shared/types/chat';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiff } from '../../renderer/components/orchestration/diff';
import { nodeExec } from './orchestration/nodeExec';
import { untrackedPatch } from './orchestration/queries';
import { parseSessionChangesInput, readSessionChanges } from './sessionChanges';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let workspace: Workspace;
let sessions: SessionSummary[];
let snapshot: OrchestrationSnapshotView;
const deps = {
  workspace: (id: string) => (id === workspace.id ? workspace : undefined),
  session: (id: string) => sessions.find((session) => session.id === id),
  snapshot: vi.fn(async () => snapshot),
};
const read = (sessionId?: string) =>
  readSessionChanges(deps, { workspaceId: workspace.id, ...(sessionId ? { sessionId } : {}) });
function commit(cwd: string, file: string, content = file) {
  writeFileSync(join(cwd, file), `${content}\n`);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}
function init(path: string) {
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.name', 'Changes test');
  git(path, 'config', 'user.email', 'changes@example.invalid');
  git(path, 'config', 'core.autocrlf', 'false');
  git(path, 'config', 'commit.gpgsign', 'false');
}
function worker(name: string): Worktree {
  const path = join(root, name);
  git(repo, 'worktree', 'add', '-qb', name, path);
  const worktree: Worktree = {
    id: `wt_${name}`,
    workspaceId: workspace.id,
    path,
    branch: name,
    baseRef: 'main',
    baseCommit: git(repo, 'rev-parse', 'HEAD'),
  };
  snapshot.worktrees.push(worktree);
  snapshot.runs.push({
    id: `run_${name}`,
    workspaceId: workspace.id,
    coordinatorSessionId: 'main',
    objective: '',
    createdAt: 1,
  });
  snapshot.tasks.push({
    id: `task_${name}`,
    runId: `run_${name}`,
    title: name,
    spec: '',
    roleId: 'worker',
    status: 'in-progress',
    dependsOn: [],
  });
  snapshot.dispatches.push({
    id: `dispatch_${name}`,
    taskId: `task_${name}`,
    worktreeId: worktree.id,
    workerSessionId: name,
    branch: name,
    startedAt: 1,
  });
  sessions.push({
    id: name,
    workspaceId: workspace.id,
    roleId: 'worker',
    title: name,
    cwd: path,
    dispatchId: `dispatch_${name}`,
    worktreeId: worktree.id,
    status: 'idle',
    approvalMode: 'supervised',
    createdAt: 1,
    updatedAt: 1,
  });
  return worktree;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-changes-')));
  repo = join(root, 'repo');
  init(repo);
  workspace = { id: 'ws-test', name: 'repo', repoPath: repo, vcs: 'git', defaultBranch: 'main' };
  sessions = [
    {
      id: 'main',
      workspaceId: workspace.id,
      cwd: '/ignored-main-session-cwd',
      roleId: 'orchestrator',
      title: 'Main',
      status: 'idle',
      approvalMode: 'supervised',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  snapshot = { runs: [], tasks: [], dispatches: [], worktrees: [], messages: [] };
  deps.snapshot.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('current conversation changes (real Git)', () => {
  it('reads the main directory with no run, including staged, unstaged, untracked, rename, deletion and binary paths', async () => {
    commit(repo, 'tracked.txt', 'before');
    commit(repo, 'remove.txt');
    commit(repo, '旧 名.txt');
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git(repo, 'add', '.');
    writeFileSync(join(repo, 'tracked.txt'), 'working\n');
    git(repo, 'mv', '旧 名.txt', '新 名.txt');
    rmSync(join(repo, 'remove.txt'));
    writeFileSync(join(repo, '未跟踪 file.txt'), 'new text\n');
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    const data = await read('main');
    expect(data.branch).toBe('main');
    expect(data.comparison.kind).toBe('latest-commit');
    expect(data.uncommitted.files).toEqual(
      expect.arrayContaining([
        'tracked.txt',
        'remove.txt',
        '新 名.txt',
        '未跟踪 file.txt',
        'binary.bin',
      ])
    );
    expect(data.uncommitted.diff).toContain('+working');
    const parsed = parseUnifiedDiff(data.uncommitted.diff);
    expect(parsed.find((file) => file.path === '新 名.txt')).toMatchObject({
      oldPath: '旧 名.txt',
      status: 'renamed',
    });
    expect(parsed.find((file) => file.path === 'binary.bin')?.binary).toBe(true);
    expect(parsed.find((file) => file.path === 'remove.txt')?.status).toBe('deleted');
    expect(parsed.find((file) => file.path === '未跟踪 file.txt')?.additions).toBe(1);
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(indexBefore);
    expect(deps.snapshot).not.toHaveBeenCalled();
    expect((await read()).uncommitted.diff).toEqual(data.uncommitted.diff);
  });

  it('isolates two workers and main, uses live branch/HEAD, and never falls back after cleanup', async () => {
    const base = commit(repo, 'base.txt');
    const first = worker('first');
    const second = worker('second');
    const firstHead = commit(first.path, 'first.txt');
    commit(second.path, 'second.txt');
    writeFileSync(join(first.path, 'first-draft.txt'), 'first');
    writeFileSync(join(second.path, 'second-draft.txt'), 'second');
    writeFileSync(join(repo, 'main-draft.txt'), 'main');
    const [main, a, b] = await Promise.all([read(), read('first'), read('second')]);
    expect(main.uncommitted.files).toEqual(['main-draft.txt']);
    expect(a).toMatchObject({
      branch: 'first',
      headCommit: firstHead,
      baseCommit: base,
      comparison: { kind: 'worker-base' },
      files: ['first.txt'],
    });
    expect(a.uncommitted.files).toEqual(['first-draft.txt']);
    expect(b.files).toEqual(['second.txt']);
    expect(b.uncommitted.files).toEqual(['second-draft.txt']);
    git(first.path, 'switch', '-qc', 'actual-branch');
    expect((await read('first')).branch).toBe('actual-branch');
    git(repo, 'worktree', 'remove', '--force', first.path);
    expect((await read('first')).availability).toBe('worktree-removed');
    snapshot.worktrees = snapshot.worktrees.filter((entry) => entry.id !== first.id);
    expect((await read('first')).availability).toBe('worktree-removed');
  });

  it('compares feature commits to default origin rather than same-name upstream, including after push', async () => {
    const base = commit(repo, 'base.txt');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'switch', '-qc', 'feature');
    commit(repo, 'feature-one.txt');
    const head = commit(repo, 'feature-two.txt');
    git(repo, 'update-ref', 'refs/remotes/origin/feature', head);
    git(repo, 'config', 'branch.feature.remote', 'origin');
    git(repo, 'config', 'branch.feature.merge', 'refs/heads/feature');
    const data = await read();
    expect(data.comparison).toEqual({ kind: 'default-branch', ref: 'refs/remotes/origin/main' });
    expect(data.baseCommit).toBe(base);
    expect(data.commits).toHaveLength(2);
    expect(data.files).toEqual(['feature-one.txt', 'feature-two.txt']);
    git(repo, 'update-ref', 'refs/remotes/origin/main', head);
    expect(await read()).toMatchObject({
      comparison: { kind: 'latest-commit' },
      files: ['feature-two.txt'],
      commits: [{ sha: head }],
    });
  });

  it('uses local default merge-base, follows branch switches, handles detached and root commit', async () => {
    const base = commit(repo, 'base.txt');
    const rootData = await read();
    expect(rootData.files).toEqual(['base.txt']);
    expect(rootData.commits.map((entry) => entry.sha)).toEqual([base]);
    git(repo, 'switch', '-qc', 'feature');
    const head = commit(repo, 'feature.txt');
    expect(await read()).toMatchObject({
      branch: 'feature',
      comparison: { kind: 'default-branch', ref: 'refs/heads/main' },
      files: ['feature.txt'],
    });
    git(repo, 'checkout', '-q', '--detach', head);
    expect(await read()).toMatchObject({ branch: '', headCommit: head, files: ['feature.txt'] });
    git(repo, 'switch', '-q', 'main');
    expect(await read()).toMatchObject({ branch: 'main', headCommit: base, files: ['base.txt'] });
  });

  it('shows staged and untracked files before the first commit, without writing objects or index', async () => {
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', '.');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const index = readFileSync(join(repo, '.git', 'index'));
    const data = await read();
    expect(data).toMatchObject({
      branch: 'main',
      headCommit: null,
      files: [],
      commits: [],
      comparison: { kind: 'unborn' },
    });
    expect(data.uncommitted.files).toEqual(['staged.txt', 'new.txt']);
    expect(data.uncommitted.diff).toContain('+staged');
    expect(data.uncommitted.diff).toContain('+new');
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index);
  });

  it('labels a merge fallback as only the latest commit and uses its first parent diff', async () => {
    const base = commit(repo, 'base.txt');
    git(repo, 'switch', '-qc', 'feature');
    commit(repo, 'feature-one.txt');
    commit(repo, 'feature-two.txt');
    git(repo, 'switch', '-q', 'main');
    git(repo, 'merge', '--no-ff', '-qm', 'merge feature', 'feature');
    const head = git(repo, 'rev-parse', 'HEAD');
    const data = await read();
    expect(data.comparison).toEqual({ kind: 'latest-commit' });
    expect(data.baseCommit).toBe(base);
    expect(data.files).toEqual(['feature-one.txt', 'feature-two.txt']);
    expect(data.commits.map((entry) => entry.sha)).toEqual([head]);
  });

  it('bounds untracked file count and rejects invalid registered ref names', async () => {
    commit(repo, 'base.txt');
    workspace.defaultBranch = 'main..bad';
    await expect(read()).rejects.toThrow('Invalid registered default branch');
    workspace.defaultBranch = 'main';
    for (let index = 0; index < 201; index++)
      writeFileSync(join(repo, `file-${index}.txt`), 'draft');
    await expect(read()).rejects.toThrow('200-file preview limit');
  });

  it('does not run Git for plain workspaces and surfaces invalid Git roots and read failures', async () => {
    const exec = vi.fn(nodeExec);
    workspace.vcs = 'none';
    expect(
      (await readSessionChanges({ ...deps, exec }, { workspaceId: workspace.id })).availability
    ).toBe('no-git');
    expect(exec).not.toHaveBeenCalled();
    workspace.vcs = 'git';
    mkdirSync(join(repo, 'nested'));
    workspace.repoPath = join(repo, 'nested');
    await expect(read()).rejects.toThrow('not the Git worktree root');
    workspace.repoPath = join(root, 'ordinary');
    mkdirSync(workspace.repoPath);
    await expect(read()).rejects.toThrow();
    workspace.repoPath = repo;
    await expect(
      readSessionChanges(
        {
          ...deps,
          exec: async () => {
            throw new Error('read denied');
          },
        },
        { workspaceId: workspace.id }
      )
    ).rejects.toThrow('read denied');
  });

  it('rejects foreign sessions, mismatched worker records, substituted repositories and main-directory aliases', async () => {
    commit(repo, 'base.txt');
    const tree = worker('worker');
    const session = sessions.find((entry) => entry.id === 'worker');
    if (!session) throw new Error('fixture');
    session.workspaceId = 'another';
    await expect(read('worker')).rejects.toThrow('does not belong');
    session.workspaceId = workspace.id;
    session.cwd = repo;
    await expect(read('worker')).rejects.toThrow('does not match');
    session.cwd = tree.path;
    git(repo, 'worktree', 'remove', tree.path);
    init(tree.path);
    await expect(read('worker')).rejects.toThrow('another Git repository');
    rmSync(tree.path, { recursive: true });
    symlinkSync(repo, tree.path, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(read('worker')).rejects.toThrow('main directory');
  });

  it('never follows untracked links or traversals, bounds content, and reports actual read errors', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, join(repo, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await untrackedPatch(repo, 'link/secret.txt', true)).not.toContain('SECRET');
    await expect(untrackedPatch(repo, '../outside/secret.txt', true)).rejects.toThrow('escapes');
    await expect(untrackedPatch(repo, 'missing', true)).rejects.toThrow();
    writeFileSync(join(repo, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
    expect(await untrackedPatch(repo, 'large.txt', true)).not.toContain('@@');
    // No secret content enters the query either.
    expect((await read()).uncommitted.diff).not.toContain('SECRET');
  });

  it('rejects a directory redirected to another registered worker', async () => {
    commit(repo, 'base.txt');
    const first = worker('one');
    const second = worker('two');
    renameSync(first.path, `${first.path}-saved`);
    symlinkSync(second.path, first.path, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(read('one')).rejects.toThrow('registered Git worktree');
  });
});

describe('changes input', () => {
  it.each([
    null,
    [],
    {},
    { workspaceId: '../x' },
    { workspaceId: 'ws', cwd: '/tmp' },
    { workspaceId: 'ws', sessionId: undefined },
    { workspaceId: 'ws', sessionId: 'C:\\x' },
    { workspaceId: 'ws', dispatchId: 'dispatch_x' },
    { workspaceId: 'ws', branch: 'main' },
  ])('rejects %j', (input) => {
    expect(parseSessionChangesInput(input)).toBeNull();
  });
  it('accepts only opaque workspace and session ids', () => {
    expect(parseSessionChangesInput({ workspaceId: 'ws' })).toEqual({ workspaceId: 'ws' });
    expect(parseSessionChangesInput({ workspaceId: 'ws', sessionId: 'session_x' })).toEqual({
      workspaceId: 'ws',
      sessionId: 'session_x',
    });
  });
});
