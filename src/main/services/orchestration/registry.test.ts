import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchTaskInput } from '@fynvra/agent-runtime';
import type { Workspace } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOrchestrationRegistry,
  type OrchestrationRegistryOptions,
  UNWIRED_LAUNCHER_ERROR,
} from './registry';
import { createFakeExec, createFakeLauncher, createFakeRoles, type FakeExec } from './testing';

const TASK: DispatchTaskInput = { title: 'Add toggle', spec: 'S', roleId: 'worker', dependsOn: [] };

let dir: string;
let fake: FakeExec;
// 仓库放在临时目录里：默认位置是仓库同级目录，resolver 会真的建出它
let WS1: Workspace;
let WS2: Workspace;

function make(overrides: Partial<OrchestrationRegistryOptions> = {}) {
  return createOrchestrationRegistry({
    userDataPath: join(dir, 'userData'),
    listWorkspaces: () => [WS1, WS2],
    roles: createFakeRoles(),
    notifyChanged: vi.fn(),
    exec: fake.exec,
    runChecks: async () => ({ exitCode: 0, output: '', durationMs: 1 }),
    log: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-orchestration-registry-'));
  fake = createFakeExec();
  WS1 = { id: 'ws_1', name: 'one', repoPath: join(dir, 'repos', 'one'), vcs: 'git' };
  WS2 = { id: 'ws_2', name: 'two', repoPath: join(dir, 'repos', 'two'), vcs: 'git' };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createOrchestrationRegistry', () => {
  it('按工作区 id 打开服务（同一个实例）；未知工作区为 undefined / null', () => {
    const registry = make();
    const service = registry.serviceFor('ws_1');
    expect(service?.workspace).toEqual(WS1);
    expect(registry.serviceFor('ws_1')).toBe(service);
    expect(registry.serviceFor('ws_missing')).toBeUndefined();
    expect(registry.hostFor('session_coord', 'ws_missing')).toBeNull();
  });

  it('launcher 接线前派发失败；setLauncher 后已打开的服务改用它；快照在 userData，worktree 默认在仓库同级', async () => {
    const registry = make();
    const host = registry.hostFor('session_coord', 'ws_1');
    expect(await host?.dispatchTask(TASK)).toMatchObject({
      ok: false,
      error: expect.stringContaining(UNWIRED_LAUNCHER_ERROR),
    });

    const launcher = createFakeLauncher();
    registry.setLauncher(launcher);
    expect(await host?.dispatchTask(TASK)).toMatchObject({ ok: true });
    expect(launcher.created()[0]?.cwd).toBe(
      join(dir, 'repos', 'one-worktrees', 'ws_1', 'add-toggle')
    );
    await registry.flushAll();
    expect(existsSync(join(dir, 'userData', 'orchestration', 'ws_1.json'))).toBe(true);
  });

  it('worktree 根目录每次建 worktree 时现算：改设置后同一会话新派的任务落到新目录，已有的不动', async () => {
    let worktreesRoot: string | undefined;
    const launcher = createFakeLauncher();
    const registry = make({ launcher, worktreesRoot: () => worktreesRoot });
    const host = registry.hostFor('session_coord', 'ws_1');

    expect(await host?.dispatchTask(TASK)).toMatchObject({ ok: true });
    worktreesRoot = join(dir, 'custom');
    expect(await host?.dispatchTask({ ...TASK, title: 'Second task' })).toMatchObject({ ok: true });

    const expected = [
      join(dir, 'repos', 'one-worktrees', 'ws_1', 'add-toggle'),
      join(dir, 'custom', 'one', 'ws_1', 'second-task'),
    ];
    expect(launcher.created().map((input) => input.cwd)).toEqual(expected);
    const snapshot = await registry.serviceFor('ws_1')?.snapshot();
    expect(snapshot?.worktrees.map((worktree) => worktree.path)).toEqual(expected);
  });

  it('仓库父目录不可写时 worktree 退回 userData/worktrees，并记 warning', async () => {
    const blocker = join(dir, 'blocker.txt');
    writeFileSync(blocker, '');
    WS2 = { ...WS2, repoPath: join(blocker, 'two') };
    const launcher = createFakeLauncher();
    const log = vi.fn();
    const registry = make({ launcher, log });

    expect(await registry.hostFor('session_coord', 'ws_2')?.dispatchTask(TASK)).toMatchObject({
      ok: true,
    });
    expect(launcher.created()[0]?.cwd).toBe(
      join(dir, 'userData', 'worktrees', 'ws_2', 'add-toggle')
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining(join(dir, 'userData', 'worktrees')));
  });

  it('workerHostFor / serviceForDispatch 跨工作区查找', async () => {
    const launcher = createFakeLauncher();
    const registry = make({ launcher });
    const result = await registry.hostFor('session_coord', 'ws_2')?.dispatchTask(TASK);
    const dispatchId = result?.ok ? result.dispatch?.id : undefined;

    expect(registry.workerHostFor('session_w1')).not.toBeNull();
    expect(registry.workerHostFor('session_coord')).toBeNull();
    expect((await registry.serviceForDispatch(dispatchId ?? ''))?.workspace.id).toBe('ws_2');
    expect(await registry.serviceForDispatch('dispatch_missing')).toBeUndefined();
  });

  it('coordinatorOf：按工作区与 run id 查到派发它的主 agent 会话', async () => {
    const launcher = createFakeLauncher();
    const registry = make({ launcher });
    await registry.hostFor('session_coord', 'ws_2')?.dispatchTask(TASK);
    const runId = launcher.created()[0]?.runId ?? '';

    expect(registry.coordinatorOf('ws_2', runId)).toBe('session_coord');
    expect(registry.coordinatorOf('ws_1', runId)).toBeUndefined();
    expect(registry.coordinatorOf('ws_missing', runId)).toBeUndefined();
    expect(registry.coordinatorOf('ws_2', 'run_missing')).toBeUndefined();
  });

  it('openAll 之后 workerHostFor 能找到磁盘快照里的 worker 会话', async () => {
    const first = make({ launcher: createFakeLauncher() });
    await first.hostFor('session_coord', 'ws_1')?.dispatchTask(TASK);
    await first.flushAll();

    const registry = make();
    expect(registry.workerHostFor('session_w1')).toBeNull();
    await registry.openAll();
    expect(registry.workerHostFor('session_w1')).not.toBeNull();
  });
});
