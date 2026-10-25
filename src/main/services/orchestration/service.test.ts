import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DispatchTaskInput } from '@fynvra/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationService, type OrchestrationServiceOptions } from './service';
import {
  createFakeExec,
  createFakeLauncher,
  createFakeRoles,
  type FakeExec,
  type FakeLauncher,
} from './testing';

const WORKSPACE = {
  id: 'ws_1',
  name: 'demo',
  repoPath: '/repo',
  vcs: 'git' as const,
  defaultBranch: 'main',
};
const TASK: DispatchTaskInput = { title: 'Add toggle', spec: 'S', roleId: 'worker', dependsOn: [] };

let dir: string;
let statePath: string;
let fake: FakeExec;
let launcher: FakeLauncher;
let notifyChanged: ReturnType<typeof vi.fn<(workspaceId: string) => void>>;

function make(overrides: Partial<OrchestrationServiceOptions> = {}) {
  return createOrchestrationService({
    workspace: WORKSPACE,
    statePath,
    resolveWorktreesRoot: async () => join(dir, 'worktrees'),
    launcher,
    roles: createFakeRoles(),
    exec: fake.exec,
    runChecks: async () => ({ exitCode: 0, output: '', durationMs: 1 }),
    fs,
    notifyChanged,
    log: () => {},
    ...overrides,
  });
}

async function dispatchOn(service: ReturnType<typeof make>) {
  const result = await service.hostFor('session_coord').dispatchTask(TASK);
  if (!result.ok || result.dispatch === undefined) throw new Error(JSON.stringify(result));
  return result.dispatch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-orchestration-service-'));
  statePath = join(dir, 'orchestration', 'ws_1.json');
  fake = createFakeExec();
  launcher = createFakeLauncher();
  notifyChanged = vi.fn<(workspaceId: string) => void>();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createOrchestrationService', () => {
  it('经 Host 的写入落盘到 orchestration/<workspaceId>.json 并通知；新实例从快照恢复', async () => {
    const service = make();
    await dispatchOn(service);
    await service.flush();

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.tasks).toHaveLength(1);
    expect(saved.dispatches).toHaveLength(1);
    expect(notifyChanged).toHaveBeenCalled();
    expect(notifyChanged.mock.calls.every(([id]) => id === 'ws_1')).toBe(true);

    const snapshot = await service.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      'dispatches',
      'messages',
      'runs',
      'tasks',
      'worktrees',
    ]);
    expect(await make().snapshot()).toEqual(snapshot);
  });

  it('同一轮里的多次写入只通知一次', async () => {
    const service = make();
    await dispatchOn(service);
    await Promise.resolve();
    notifyChanged.mockClear();
    const [dispatch] = (await service.snapshot()).dispatches;
    // reportDone 同步写 dispatch、task、message 三张表
    await service.workerHostFor(dispatch?.workerSessionId ?? '')?.reportDone('succeeded', 'Done.');
    await Promise.resolve();
    expect(notifyChanged).toHaveBeenCalledTimes(1);
  });

  it('workerHostFor：按 Dispatch.workerSessionId 反查；打回后同一个 WorkerHost 绑定到新尝试', async () => {
    const service = make();
    await service.ready;
    expect(service.workerHostFor('session_unknown')).toBeNull();

    const dispatch = await dispatchOn(service);
    const worker = service.workerHostFor(dispatch.workerSessionId);
    expect(worker).not.toBeNull();
    expect(await worker?.reportDone('succeeded', 'Done.')).toEqual({ ok: true });

    const host = service.hostFor('session_coord');
    expect(await host.rejectWork({ dispatchId: dispatch.id, feedback: 'Again.' })).toMatchObject({
      ok: true,
    });
    expect(await worker?.reportDone('succeeded', 'Done again.')).toEqual({ ok: true });
    const snapshot = await service.snapshot();
    expect(snapshot.dispatches.map((d) => [d.workerSessionId, d.summary])).toEqual([
      ['session_w1', 'Done.'],
      ['session_w1', 'Done again.'],
    ]);
    expect(snapshot.tasks[0]?.status).toBe('in-review');
  });

  it('coordinatorOf：起 worker 会话时 Run 已经落库，按 run id 能查到主 agent 会话', async () => {
    const service = make();
    let seen: string | undefined;
    // launcher 被调用时 Dispatch 还没写入，worker 会话的 parentSessionId 只能经 Run 反查
    launcher.createWorkerSession.mockImplementationOnce(async (input) => {
      seen = service.coordinatorOf(input.runId);
      return { ok: true, sessionId: 'session_w1' };
    });
    await dispatchOn(service);
    expect(seen).toBe('session_coord');
    expect(service.coordinatorOf('run_missing')).toBeUndefined();
  });

  it('快照加载完成前 workerHostFor 返回 null，加载后能找到磁盘上的 worker 会话', async () => {
    const first = make();
    await dispatchOn(first);
    await first.flush();
    const service = make();
    expect(service.workerHostFor('session_w1')).toBeNull();
    await service.ready;
    expect(service.workerHostFor('session_w1')).not.toBeNull();
  });

  it('hostFor：仓库处于 detached HEAD 时报错且不缓存，切回分支后即可使用', async () => {
    let head: { code: number; stdout: string } = { code: 1, stdout: '' };
    fake.respond(({ args }) => (args[0] === 'symbolic-ref' ? head : undefined));
    const host = make().hostFor('session_coord');
    expect(await host.listWorkers()).toMatchObject({
      ok: false,
      error: expect.stringContaining('detached HEAD'),
    });
    head = { code: 0, stdout: 'main\n' };
    expect(await host.listWorkers()).toEqual({ ok: true, workers: [] });
  });

  it('主 agent 的分支在首次使用时确定：之后仓库换了分支，worktree 仍从原分支切出、合并被拒绝', async () => {
    const service = make();
    const host = service.hostFor('session_coord');
    await host.listWorkers();
    fake.respond(({ args }) => (args[0] === 'symbolic-ref' ? { stdout: 'feature\n' } : undefined));

    const dispatch = await dispatchOn(service);
    expect(fake.commands()).toContain('git rev-parse --verify --quiet main^{commit}');
    await service.workerHostFor(dispatch.workerSessionId)?.reportDone('succeeded', 'Done.');
    expect(await host.mergeWorktree({ dispatchId: dispatch.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('branch feature'),
    });
  });

  it('readWorkerOutput / reviewDiff 按 dispatch id 查询（面板用，不限定主 agent）', async () => {
    const service = make();
    const dispatch = await dispatchOn(service);
    launcher.readTranscript.mockResolvedValueOnce({
      ok: true,
      text: 'hello',
      total: 5,
      done: false,
    });
    expect(await service.readWorkerOutput({ dispatchId: dispatch.id, cursor: 0 })).toEqual({
      ok: true,
      text: 'hello',
      total: 5,
      done: false,
    });
    expect(await service.reviewDiff(dispatch.id)).toMatchObject({
      ok: true,
      branch: 'fynvra/add-toggle',
      files: ['src/a.ts'],
    });
    expect(await service.readWorkerOutput({ dispatchId: 'dispatch_x', cursor: 0 })).toMatchObject({
      ok: false,
    });
    expect(await service.reviewDiff('dispatch_x')).toMatchObject({ ok: false });
  });

  describe('cleanupMergedWorktree（归档会话时清理它的 worktree）', () => {
    /** 派发 → 汇报 → 合并；合并之后基准分支包含 worker 的全部提交（ahead 为 0） */
    async function mergedDispatch(service: ReturnType<typeof make>) {
      const dispatch = await dispatchOn(service);
      await service.workerHostFor(dispatch.workerSessionId)?.reportDone('succeeded', 'Done.');
      const host = service.hostFor('session_coord');
      expect(await host.mergeWorktree({ dispatchId: dispatch.id })).toMatchObject({ merged: true });
      fake.respond(({ args }) => (args[0] === 'rev-list' ? { stdout: '2\t0\n' } : undefined));
      return dispatch;
    }

    it('已合并且干净：停 worker，删 worktree（不加 --force）与分支（-d），记录随之删除', async () => {
      const service = make();
      const dispatch = await mergedDispatch(service);
      const [worktree] = (await service.snapshot()).worktrees;
      launcher.disposeSession.mockClear();
      const before = fake.calls.length;

      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: true,
      });
      const commands = fake.commands().slice(before);
      expect(commands).toContain(`git worktree remove -- ${worktree?.path}`);
      expect(commands).toContain('git branch -d fynvra/add-toggle');
      expect(launcher.disposeSession).toHaveBeenCalledWith(dispatch.workerSessionId);
      expect((await service.snapshot()).worktrees).toEqual([]);
      // 再调一次：已经没有 worktree 了
      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: false,
        reason: 'no-worktree',
      });
    });

    it('任务还没合并：不碰 worktree', async () => {
      const service = make();
      const dispatch = await dispatchOn(service);
      await service.workerHostFor(dispatch.workerSessionId)?.reportDone('succeeded', 'Done.');
      const before = fake.calls.length;
      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: false,
        reason: 'not-merged',
      });
      const after = fake.commands().slice(before);
      expect(after.filter((line) => line.includes('remove'))).toEqual([]);
      expect((await service.snapshot()).worktrees).toHaveLength(1);
      expect(launcher.disposeSession).not.toHaveBeenCalled();
    });

    it('合并之后又有改动或新提交：保留', async () => {
      const service = make();
      const dispatch = await mergedDispatch(service);
      fake.respond(({ args }) => (args[0] === 'rev-list' ? { stdout: '2\t1\n' } : undefined));
      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: false,
        reason: 'unmerged-commits',
      });
      fake.respond(({ args }) => (args[0] === 'status' ? { stdout: '?? notes.md\n' } : undefined));
      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: false,
        reason: 'dirty',
      });
      expect((await service.snapshot()).worktrees).toHaveLength(1);
    });

    it('git 拒绝删除时保留记录并带上原因；不是 worker 的会话没有可清理的', async () => {
      const service = make();
      const dispatch = await mergedDispatch(service);
      fake.respond(({ args }) =>
        args[0] === 'worktree' && args[1] === 'remove'
          ? { code: 128, stderr: 'fatal: contains modified or untracked files' }
          : undefined
      );
      expect(await service.cleanupMergedWorktree(dispatch.workerSessionId)).toEqual({
        removed: false,
        reason: 'failed',
        error: expect.stringContaining('untracked'),
      });
      expect((await service.snapshot()).worktrees).toHaveLength(1);
      expect(await service.cleanupMergedWorktree('session_coord')).toEqual({
        removed: false,
        reason: 'no-worktree',
      });
    });
  });

  it('快照文件读不懂：挪到一边，以空状态开始并记日志', async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{ not json');
    const log = vi.fn();
    const service = make({ log });
    expect(await service.snapshot()).toEqual({
      runs: [],
      tasks: [],
      dispatches: [],
      worktrees: [],
      messages: [],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    expect(existsSync(statePath)).toBe(false);
    expect(
      readdirSync(dirname(statePath)).some((file) => file.startsWith('ws_1.json.unreadable-'))
    ).toBe(true);
  });

  it('普通目录：不读分支（可能是仓库子目录，git 读得到外层仓库），派发原地进行，落盘后恢复出 in-place', async () => {
    const service = make({
      workspace: { id: 'ws_1', name: 'notes', repoPath: '/notes', vcs: 'none' },
    });
    const dispatch = await dispatchOn(service);
    expect(dispatch).toMatchObject({ mode: 'in-place', worktreeId: '' });
    expect(fake.calls).toEqual([]);
    await service.flush();

    const restored = make({
      workspace: { id: 'ws_1', name: 'notes', repoPath: '/notes', vcs: 'none' },
    });
    expect((await restored.snapshot()).dispatches).toEqual([dispatch]);
    // 面板的「改动」不给 diff
    expect(await restored.reviewDiff(dispatch.id)).toEqual({
      ok: false,
      error: `dispatch ${dispatch.id} has no diff: the workspace has no git`,
    });
    expect(fake.calls).toEqual([]);
  });
});
