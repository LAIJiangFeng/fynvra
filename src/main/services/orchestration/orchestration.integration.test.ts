import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationHost } from '@fynvra/agent-runtime';
import type { ExecFn, Worktree } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeExec } from './nodeExec';
import { createOrchestrationService, type OrchestrationService } from './service';
import { createShellRunner } from './shellRunner';
import { createFakeLauncher, createFakeRoles, type FakeLauncher } from './testing';
import { createWorktreesRootResolver } from './worktreesRoot';

const hasGit = spawnSync('git', ['--version']).status === 0;

// 真实 git 仓库 + worktree + 子进程，Windows 上较慢
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', message);
}

/** 去掉若干字段：面板结果的未提交改动随 worktree 存亡变化，agent 工具结果没有面板专有字段。 */
function omit(result: object, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !keys.includes(key)));
}

describe.skipIf(!hasGit)('编排全流程（真实 git）', () => {
  let root: string;
  let repo: string;
  let statePath: string;
  let launcher: FakeLauncher;
  let service: OrchestrationService;
  let host: OrchestrationHost;

  function openService(): OrchestrationService {
    return createOrchestrationService({
      workspace: { id: 'ws_1', name: 'repo', repoPath: repo, vcs: 'git', defaultBranch: 'main' },
      statePath,
      resolveWorktreesRoot: async () => join(root, 'userData', 'worktrees'),
      launcher,
      roles: createFakeRoles(),
      exec: nodeExec,
      runChecks: createShellRunner(),
      fs,
      notifyChanged: () => {},
      log: () => {},
    });
  }

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-orchestration-it-')));
    repo = join(root, 'repo');
    statePath = join(root, 'userData', 'orchestration', 'ws_1.json');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'fynvra-test');
    git(repo, 'config', 'user.email', 'test@fynvra.invalid');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'commit.gpgsign', 'false');
    commitFile(repo, 'a.txt', 'base\n', 'init');

    launcher = createFakeLauncher();
    service = openService();
    host = service.hostFor('session_coord');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  async function dispatch(title: string) {
    const result = await host.dispatchTask({
      title,
      spec: `## Change\n${title}.`,
      roleId: 'worker',
      dependsOn: [],
    });
    if (!result.ok || result.dispatch === undefined) throw new Error(JSON.stringify(result));
    const worktree = await worktreeOf(result.dispatch.worktreeId);
    return { task: result.task, dispatch: result.dispatch, worktree };
  }

  async function worktreeOf(id: string): Promise<Worktree> {
    const worktree = (await service.snapshot()).worktrees.find((candidate) => candidate.id === id);
    if (worktree === undefined) throw new Error(`worktree ${id} not registered`);
    return worktree;
  }

  /** 扮演 worker：经 Main 的 workerHostFor（与真实接线相同的反查路径）汇报。 */
  async function report(sessionId: string, summary = 'Done.') {
    const worker = service.workerHostFor(sessionId);
    expect(worker).not.toBeNull();
    expect(await worker?.reportDone('succeeded', summary)).toEqual({ ok: true });
  }

  it('派发 → worker 在 worktree 里提交 → reportDone → review → run_checks → merge → cleanup', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Add feature');
    expect(worktree.path).toBe(join(root, 'userData', 'worktrees', 'ws_1', 'add-feature'));
    expect(git(worktree.path, 'branch', '--show-current')).toBe('fynvra/add-feature');
    expect(worktree.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(launcher.created()[0]?.brief).toContain('report_done');

    commitFile(worktree.path, 'feature.txt', 'hello\n', 'add feature');
    await report(attempt.workerSessionId, 'Added feature.txt');

    const waited = await host.waitForWorkers({ timeoutMs: 5_000, until: 'all' });
    expect(waited).toMatchObject({ ok: true, timedOut: false, pending: 0 });
    expect(waited.ok && waited.messages.map((m) => [m.type, m.subject])).toEqual([
      ['worker_done', 'succeeded'],
    ]);

    const review = await host.reviewDiff({ dispatchId: attempt.id });
    expect(review).toMatchObject({
      ok: true,
      branch: 'fynvra/add-feature',
      files: ['feature.txt'],
    });
    expect(review.ok && review.stat).toContain('feature.txt');
    expect(review.ok && review.diff).toContain('+hello');

    const checks = await host.runChecks({
      dispatchId: attempt.id,
      command: 'git status --porcelain && node --version',
    });
    expect(checks).toMatchObject({ ok: true, exitCode: 0 });
    expect(checks.ok && checks.output).toMatch(/v\d+\.\d+/);

    const merged = await host.mergeWorktree({ dispatchId: attempt.id });
    expect(merged).toMatchObject({ ok: true, merged: true, targetBranch: 'main' });
    expect(merged.ok && merged.commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    // --no-ff：HEAD 是有两个父提交的合并提交
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('hello\n');

    expect(await host.cleanupWorktree({ dispatchId: attempt.id })).toEqual({
      ok: true,
      removedWorktree: true,
      deletedBranch: true,
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'fynvra/*')).toBe('');
    expect(launcher.disposeSession).toHaveBeenCalledWith(attempt.workerSessionId);

    const snapshot = await service.snapshot();
    expect(snapshot.tasks.map((task) => task.status)).toEqual(['completed']);
    expect(snapshot.worktrees).toEqual([]);
    await service.flush();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks[0].status).toBe('completed');
  });

  it('旧记录的 worktree 已注销但残留目录还在：工具和面板从主仓库读取 worker 分支', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Removed directory');
    commitFile(worktree.path, 'worker.txt', 'worker change\n', 'worker change');
    await report(attempt.workerSessionId);
    const expected = await service.reviewDiff(attempt.id);
    expect(expected).toMatchObject({
      ok: true,
      files: ['worker.txt'],
      uncommitted: { available: true, files: [], diff: '' },
      commits: [{ subject: 'worker change' }],
    });
    const committed = omit(expected, 'uncommitted');
    const tool = omit(expected, 'uncommitted', 'commits');

    // 模拟旧版 Windows 清理失败：Git 登记和 .git 已删，应用仍保留 worktree 记录。
    git(repo, 'merge', '--no-ff', '--no-edit', worktree.branch);
    git(repo, 'worktree', 'remove', worktree.path);
    mkdirSync(worktree.path);
    commitFile(repo, 'unrelated.txt', 'not part of this task\n', 'unrelated');
    const panel = await service.reviewDiff(attempt.id);
    expect(omit(panel, 'uncommitted')).toEqual(committed);
    expect(panel.ok && panel.uncommitted).toEqual({ available: false, files: [], diff: '' });
    expect(await host.reviewDiff({ dispatchId: attempt.id })).toEqual(tool);

    rmSync(worktree.path, { recursive: true });
    expect(omit(await service.reviewDiff(attempt.id), 'uncommitted')).toEqual(committed);
  });

  it.each(['coordinator', 'archive'] as const)(
    '%s 清理 worktree 与分支后，重启仍读取固定提交，不混入主分支或同名新分支的改动',
    async (cleanup) => {
      const { dispatch: attempt, worktree } = await dispatch('Historical change');
      commitFile(worktree.path, 'worker.txt', 'original change\n', 'worker change');
      await report(attempt.workerSessionId);
      const expected = await service.reviewDiff(attempt.id);
      expect(expected).toMatchObject({
        ok: true,
        files: ['worker.txt'],
        commits: [{ subject: 'worker change' }],
      });
      const committed = omit(expected, 'uncommitted');
      const tool = omit(expected, 'uncommitted', 'commits');
      // 主分支在 worker 期间前进：不能用主分支 HEAD 或合并提交作为 diff 终点。
      commitFile(repo, 'unrelated.txt', 'another task\n', 'unrelated');
      expect(await host.mergeWorktree({ dispatchId: attempt.id })).toMatchObject({ merged: true });
      if (cleanup === 'coordinator') {
        expect(await host.cleanupWorktree({ dispatchId: attempt.id })).toMatchObject({
          ok: true,
          deletedBranch: true,
        });
      } else {
        expect(await service.cleanupMergedWorktree(attempt.workerSessionId)).toEqual({
          removed: true,
        });
      }
      expect((await service.snapshot()).worktrees).toEqual([]);
      expect(git(repo, 'branch', '--list', worktree.branch)).toBe('');
      const panel = await service.reviewDiff(attempt.id);
      expect(omit(panel, 'uncommitted')).toEqual(committed);
      expect(panel.ok && panel.uncommitted.available).toBe(false);
      expect(await host.reviewDiff({ dispatchId: attempt.id })).toEqual(tool);
      await service.flush();

      commitFile(repo, 'later.txt', 'later change\n', 'later');
      git(repo, 'branch', worktree.branch);
      const restored = openService();
      expect(omit(await restored.reviewDiff(attempt.id), 'uncommitted')).toEqual(committed);
      expect(
        await restored.hostFor('session_coord').reviewDiff({ dispatchId: attempt.id })
      ).toEqual(tool);
    }
  );

  it('面板的未提交改动：已跟踪文件的改动与未跟踪文件（新增），不写 worktree', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Uncommitted');
    commitFile(worktree.path, 'tracked.txt', 'one\n', 'add tracked');
    writeFileSync(join(worktree.path, 'tracked.txt'), 'one\ntwo\n');
    writeFileSync(join(worktree.path, 'new file.txt'), 'fresh');
    writeFileSync(join(worktree.path, 'blob.bin'), Buffer.from([1, 0, 2]));
    const status = git(worktree.path, 'status', '--porcelain');

    const result = await service.reviewDiff(attempt.id);
    expect(result).toMatchObject({ ok: true, files: ['tracked.txt'] });
    if (!result.ok) return;
    expect(result.uncommitted.available).toBe(true);
    expect([...result.uncommitted.files].sort()).toEqual([
      'blob.bin',
      'new file.txt',
      'tracked.txt',
    ]);
    expect(result.uncommitted.diff).toContain('+two');
    expect(result.uncommitted.diff).toContain(
      'diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\n@@ -0,0 +1,1 @@\n+fresh\n\\ No newline at end of file\n'
    );
    expect(result.uncommitted.diff).toContain('Binary files /dev/null and b/blob.bin differ');
    expect(result.commits).toMatchObject([{ subject: 'add tracked', author: expect.any(String) }]);
    expect(result.commits[0]?.sha).toBe(git(worktree.path, 'rev-parse', 'HEAD'));
    expect(git(worktree.path, 'status', '--porcelain')).toBe(status);
    expect(await host.reviewDiff({ dispatchId: attempt.id })).not.toHaveProperty('uncommitted');
  });

  it('worker 分支已丢失时不能悄悄显示主仓库 HEAD 的改动', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Missing branch');
    commitFile(worktree.path, 'worker.txt', 'worker change\n', 'worker change');
    git(repo, 'worktree', 'remove', worktree.path);
    git(repo, 'branch', '-D', worktree.branch);
    commitFile(repo, 'unrelated.txt', 'not worker changes\n', 'unrelated');
    expect(await service.reviewDiff(attempt.id)).toMatchObject({ ok: false });
  });

  it('冲突：worker 与主分支改了同一行 → merged: false 并列出冲突文件，主仓库回到合并前', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Edit a');
    commitFile(worktree.path, 'a.txt', 'worker\n', 'worker edit');
    commitFile(repo, 'a.txt', 'main\n', 'main edit');
    const before = git(repo, 'rev-parse', 'HEAD');
    await report(attempt.workerSessionId);

    expect(await host.mergeWorktree({ dispatchId: attempt.id })).toEqual({
      ok: true,
      merged: false,
      targetBranch: 'main',
      conflicts: ['a.txt'],
    });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await service.snapshot()).tasks[0]?.status).toBe('in-review');
  });

  it('打回：反馈作为新 prompt 发给 worker，同一 worktree 上继续提交，再次汇报后合并', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Add docs');
    commitFile(worktree.path, 'docs.md', 'v1\n', 'docs v1');
    await report(attempt.workerSessionId);

    expect(
      await host.rejectWork({ dispatchId: attempt.id, feedback: 'Mention the API.' })
    ).toMatchObject({ ok: true });
    expect(launcher.promptSession).toHaveBeenCalledWith(
      attempt.workerSessionId,
      expect.stringContaining('Mention the API.')
    );
    expect((await service.snapshot()).tasks[0]?.status).toBe('in-progress');

    commitFile(worktree.path, 'docs.md', 'v2 with API\n', 'docs v2');
    await report(attempt.workerSessionId, 'Mentioned the API.');
    const waited = await host.waitForWorkers({ timeoutMs: 5_000, until: 'any' });
    const latest = waited.ok ? waited.messages.at(-1) : undefined;
    expect(latest).toMatchObject({ type: 'worker_done', body: 'Mentioned the API.' });
    expect(latest?.dispatchId).not.toBe(attempt.id);

    expect(await host.mergeWorktree({ dispatchId: latest?.dispatchId ?? '' })).toMatchObject({
      ok: true,
      merged: true,
    });
    expect(readFileSync(join(repo, 'docs.md'), 'utf8')).toBe('v2 with API\n');
  });

  it('worker 留下未提交改动：拒绝合并；run_checks 拒绝白名单外的命令且什么都不执行', async () => {
    const { dispatch: attempt, worktree } = await dispatch('Dirty work');
    commitFile(worktree.path, 'x.txt', 'x\n', 'x');
    writeFileSync(join(worktree.path, 'scratch.txt'), 'wip');
    await report(attempt.workerSessionId);

    expect(await host.mergeWorktree({ dispatchId: attempt.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('uncommitted'),
    });
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1);

    for (const command of [
      'node --version && rm -rf .',
      'git commit -am sneaky',
      'git push origin HEAD',
      "node -e \"require('fs').rmSync('x.txt')\"",
      'git status > out.txt',
    ]) {
      expect(await host.runChecks({ dispatchId: attempt.id, command })).toMatchObject({
        ok: false,
      });
    }
    expect(existsSync(join(worktree.path, 'x.txt'))).toBe(true);
    expect(existsSync(join(worktree.path, 'out.txt'))).toBe(false);
    expect(git(worktree.path, 'log', '--oneline').split('\n')).toHaveLength(2);
  });

  it('依赖：排队的任务在前一个合并后从更新过的主分支切出', async () => {
    const first = await dispatch('Base layer');
    commitFile(first.worktree.path, 'base.txt', 'base\n', 'base layer');
    await report(first.dispatch.workerSessionId);
    const queued = await host.dispatchTask({
      title: 'On top',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [first.task.id],
    });
    expect(queued.ok && queued.dispatch).toBeUndefined();

    expect(await host.mergeWorktree({ dispatchId: first.dispatch.id })).toMatchObject({
      merged: true,
    });
    const listed = await host.listWorkers();
    const second = listed.ok ? listed.workers[1]?.dispatch : undefined;
    expect(second).toBeDefined();
    const worktree = await worktreeOf(second?.worktreeId ?? '');
    expect(worktree.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(worktree.path, 'base.txt'))).toBe(true);
  });

  it('归档时清理：只删合并过且干净的 worktree（被忽略的 node_modules 不挡），分支一起删', async () => {
    commitFile(repo, '.gitignore', 'node_modules/\n', 'ignore node_modules');
    const merged = await dispatch('Merged work');
    commitFile(merged.worktree.path, 'merged.txt', 'm\n', 'merged work');
    mkdirSync(join(merged.worktree.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(merged.worktree.path, 'node_modules', 'pkg', 'index.js'), 'x');
    await report(merged.dispatch.workerSessionId);
    expect(await host.mergeWorktree({ dispatchId: merged.dispatch.id })).toMatchObject({
      merged: true,
    });

    const pending = await dispatch('Pending work');
    commitFile(pending.worktree.path, 'pending.txt', 'p\n', 'pending work');
    await report(pending.dispatch.workerSessionId);
    expect(await service.cleanupMergedWorktree(pending.dispatch.workerSessionId)).toEqual({
      removed: false,
      reason: 'not-merged',
    });

    // 合并之后 worker 又提交了一次：保留；撤掉那次提交后才删
    commitFile(merged.worktree.path, 'late.txt', 'late\n', 'after the merge');
    expect(await service.cleanupMergedWorktree(merged.dispatch.workerSessionId)).toEqual({
      removed: false,
      reason: 'unmerged-commits',
    });
    git(merged.worktree.path, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(merged.worktree.path, 'notes.md'), 'scratch');
    expect(await service.cleanupMergedWorktree(merged.dispatch.workerSessionId)).toEqual({
      removed: false,
      reason: 'dirty',
    });
    rmSync(join(merged.worktree.path, 'notes.md'));

    expect(await service.cleanupMergedWorktree(merged.dispatch.workerSessionId)).toEqual({
      removed: true,
    });
    expect(existsSync(merged.worktree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'fynvra/merged-work')).toBe('');
    expect(existsSync(pending.worktree.path)).toBe(true);
    expect(git(repo, 'branch', '--list', 'fynvra/pending-work')).toContain('fynvra/pending-work');
    expect((await service.snapshot()).worktrees.map((worktree) => worktree.id)).toEqual([
      pending.worktree.id,
    ]);
  });

  it('worker 会话起不来：真实的 worktree 与分支都被回滚', async () => {
    launcher.createWorkerSession.mockResolvedValueOnce({ ok: false, error: 'no model' });
    expect(
      await host.dispatchTask({ title: 'Doomed', spec: 'S', roleId: 'worker', dependsOn: [] })
    ).toMatchObject({ ok: false, error: expect.stringContaining('no model') });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('doomed');
    expect(git(repo, 'branch', '--list', 'fynvra/*')).toBe('');
    expect(existsSync(join(root, 'userData', 'worktrees', 'ws_1', 'doomed'))).toBe(false);
  });

  it('默认位置：worktree 建在仓库同级的 <仓库目录名>-worktrees 下，cleanup 照记录的路径删除', async () => {
    const sibling = createOrchestrationService({
      workspace: { id: 'ws_1', name: 'repo', repoPath: repo, vcs: 'git', defaultBranch: 'main' },
      statePath: join(root, 'userData', 'orchestration', 'sibling.json'),
      resolveWorktreesRoot: createWorktreesRootResolver({
        fallbackRoot: join(root, 'userData', 'worktrees'),
        configured: () => undefined,
        repoPaths: () => [repo],
        log: () => {},
      }),
      launcher,
      roles: createFakeRoles(),
      exec: nodeExec,
      runChecks: createShellRunner(),
      fs,
      notifyChanged: () => {},
      log: () => {},
    });
    const coordinator = sibling.hostFor('session_sibling');
    const result = await coordinator.dispatchTask({
      title: 'Next to repo',
      spec: 'S',
      roleId: 'worker',
      dependsOn: [],
    });
    if (!result.ok || result.dispatch === undefined) throw new Error(JSON.stringify(result));

    const path = join(root, 'repo-worktrees', 'ws_1', 'next-to-repo');
    expect((await sibling.snapshot()).worktrees.map((worktree) => worktree.path)).toEqual([path]);
    expect(git(path, 'branch', '--show-current')).toBe('fynvra/next-to-repo');
    expect(existsSync(join(root, 'userData', 'worktrees'))).toBe(false);

    expect(await coordinator.cleanupWorktree({ dispatchId: result.dispatch.id })).toMatchObject({
      ok: true,
      removedWorktree: true,
    });
    expect(existsSync(path)).toBe(false);
  });
});

// 不依赖 git：没装 git 的机器上也跑
describe('编排全流程（普通目录，没有 git）', () => {
  let root: string;
  let notes: string;
  let statePath: string;
  let launcher: FakeLauncher;
  let execCalls: string[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-orchestration-plain-')));
    notes = join(root, 'notes');
    statePath = join(root, 'userData', 'orchestration', 'ws_plain.json');
    mkdirSync(notes);
    writeFileSync(join(notes, 'README.md'), 'notes\n');
    // 验收命令：在 cwd 里读 hello.txt，证明 run_checks 跑在工作区目录里
    writeFileSync(
      join(notes, 'check.js'),
      "process.stdout.write(require('node:fs').readFileSync('hello.txt', 'utf8'));\n"
    );
    launcher = createFakeLauncher();
    execCalls = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  function plainService(): OrchestrationService {
    // 记下 Host / Service 经 exec 跑的每一条命令（git 都走它）
    const exec: ExecFn = (cmd, args, cwd) => {
      execCalls.push(`${cmd} ${args.join(' ')}`);
      return nodeExec(cmd, args, cwd);
    };
    return createOrchestrationService({
      workspace: { id: 'ws_plain', name: 'notes', repoPath: notes, vcs: 'none' },
      statePath,
      resolveWorktreesRoot: async () => {
        throw new Error('a plain directory has no worktrees');
      },
      launcher,
      roles: createFakeRoles(),
      exec,
      runChecks: createShellRunner(),
      fs,
      notifyChanged: () => {},
      log: () => {},
    });
  }

  it('派发 → worker 在目录里写文件 → report_done → review / run_checks → 验收 completed → cleanup，全程没有调用 git', async () => {
    const service = plainService();
    const host = service.hostFor('session_coord');
    const dispatched = await host.dispatchTask({
      title: 'Create hello',
      spec: '## Change\nCreate hello.txt.',
      roleId: 'worker',
      dependsOn: [],
    });
    if (!dispatched.ok || dispatched.dispatch === undefined) {
      throw new Error(JSON.stringify(dispatched));
    }
    const attempt = dispatched.dispatch;
    expect(attempt).toMatchObject({ mode: 'in-place', worktreeId: '', branch: '' });
    expect(launcher.created()[0]).toMatchObject({ cwd: notes });

    // 扮演 worker：直接在工作区目录里写文件，再经 Main 的 workerHostFor（真实接线的反查路径）汇报
    writeFileSync(join(notes, 'hello.txt'), 'hello\n');
    const worker = service.workerHostFor(attempt.workerSessionId);
    expect(await worker?.reportDone('succeeded', 'Created hello.txt', ['hello.txt'])).toEqual({
      ok: true,
    });
    const waited = await host.waitForWorkers({ timeoutMs: 5_000, until: 'all' });
    expect(waited).toMatchObject({ ok: true, timedOut: false, pending: 0 });

    expect(await host.reviewDiff({ dispatchId: attempt.id })).toMatchObject({
      ok: true,
      mode: 'in-place',
      files: ['hello.txt'],
    });
    const checks = await host.runChecks({ dispatchId: attempt.id, command: 'node check.js' });
    expect(checks).toMatchObject({ ok: true, exitCode: 0 });
    expect(checks.ok && checks.output).toContain('hello');

    expect(await host.mergeWorktree({ dispatchId: attempt.id })).toEqual({
      ok: true,
      merged: true,
      targetBranch: '',
      mode: 'in-place',
    });
    expect(await host.cleanupWorktree({ dispatchId: attempt.id })).toMatchObject({
      ok: true,
      mode: 'in-place',
    });
    expect(launcher.disposeSession).toHaveBeenCalledWith(attempt.workerSessionId);

    // 改动原地留在目录里；目录旁边没有建出 worktree 目录，也没有 .git
    expect(readFileSync(join(notes, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(notes, '.git'))).toBe(false);
    expect(existsSync(join(root, 'notes-worktrees'))).toBe(false);
    expect(execCalls).toEqual([]);

    const snapshot = await service.snapshot();
    expect(snapshot.tasks.map((task) => task.status)).toEqual(['completed']);
    expect(snapshot.worktrees).toEqual([]);
    await service.flush();
    // 重启后从快照恢复：仍是 in-place 的尝试
    expect((await plainService().snapshot()).dispatches).toEqual(snapshot.dispatches);
    expect(snapshot.dispatches[0]).toMatchObject({ mode: 'in-place', outcome: 'succeeded' });
  });
});
