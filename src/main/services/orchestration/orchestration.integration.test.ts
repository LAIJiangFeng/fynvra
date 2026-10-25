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
import type { Worktree } from '@fynvra/core';
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

describe.skipIf(!hasGit)('编排全流程（真实 git）', () => {
  let root: string;
  let repo: string;
  let statePath: string;
  let launcher: FakeLauncher;
  let service: OrchestrationService;
  let host: OrchestrationHost;

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
    service = createOrchestrationService({
      workspace: { id: 'ws_1', name: 'repo', repoPath: repo, defaultBranch: 'main' },
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
      workspace: { id: 'ws_1', name: 'repo', repoPath: repo, defaultBranch: 'main' },
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
