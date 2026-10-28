import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentHost } from '../services/agentHost/agentHost';
import { createFakeLauncher, createFakeRoles } from '../services/orchestration/testing';
import { createSessionStore } from '../services/sessions/sessionStore';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}));

vi.mock('./sessions', () => ({
  getSessionStore: () => ({ get: () => undefined }),
  getAgentHost: () => {
    throw new Error('Changes must not start the agent host');
  },
}));

const WORKSPACE_ID = 'ws-1';
const DISPATCH_ID = 'dispatch_0mh4x2k1c7q2v9z0d3f';
const SNAPSHOT = {
  version: 1,
  runs: [
    {
      id: 'run_1',
      workspaceId: WORKSPACE_ID,
      coordinatorSessionId: 'session_coord',
      objective: 'demo',
      createdAt: 1,
    },
  ],
  tasks: [
    {
      id: 'task_1',
      runId: 'run_1',
      title: 'Add toggle',
      spec: 'S',
      roleId: 'worker',
      status: 'in-progress',
      dependsOn: [],
    },
  ],
  dispatches: [
    {
      id: DISPATCH_ID,
      taskId: 'task_1',
      workerSessionId: 'session_w1',
      worktreeId: 'wt_1',
      branch: 'fynvra/add-toggle',
      startedAt: 2,
    },
  ],
  worktrees: [] as unknown[],
  messages: [] as unknown[],
};

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

beforeAll(async () => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'fynvra-ipc-orchestration-'));
  const repoPath = join(mocks.userData, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'main-draft.txt'), 'main changes\n');
  SNAPSHOT.worktrees.push({
    id: 'wt_1',
    workspaceId: WORKSPACE_ID,
    // 目录不存在：review-diff 走 git 失败路径
    path: join(mocks.userData, 'worktrees', WORKSPACE_ID, 'add-toggle'),
    branch: 'fynvra/add-toggle',
    baseRef: 'main',
    baseCommit: 'abc1234',
  });
  const orphanRepoPath = join(mocks.userData, 'orphan-repo');
  mkdirSync(orphanRepoPath);
  writeFileSync(
    join(mocks.userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      preferences: {},
      workspaces: [
        { id: WORKSPACE_ID, name: 'demo', repoPath, defaultBranch: 'main' },
        { id: 'ws-orphan', name: 'Old tasks', repoPath: orphanRepoPath, vcs: 'none' },
      ],
    })
  );
  mkdirSync(join(mocks.userData, 'orchestration'));
  writeFileSync(
    join(mocks.userData, 'orchestration', `${WORKSPACE_ID}.json`),
    JSON.stringify(SNAPSHOT)
  );
  writeFileSync(
    join(mocks.userData, 'orchestration', 'ws-orphan.json'),
    JSON.stringify({
      ...SNAPSHOT,
      runs: [{ ...SNAPSHOT.runs[0], workspaceId: 'ws-orphan' }],
      dispatches: [{ ...SNAPSHOT.dispatches[0], workerSessionId: 'session_removed' }],
      worktrees: SNAPSHOT.worktrees.map((worktree) => ({
        ...(worktree as object),
        workspaceId: 'ws-orphan',
      })),
    })
  );
  const { registerOrchestrationHandlers } = await import('./orchestration');
  registerOrchestrationHandlers();
});

afterAll(async () => {
  const { getOrchestrationRegistry } = await import('./orchestration');
  await getOrchestrationRegistry().flushAll();
  rmSync(mocks.userData, { recursive: true, force: true });
});

describe('orchestration IPC', () => {
  it('注册快照、输出、历史审查与当前目录改动通道', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.ORCHESTRATION_CHANGES,
        IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT,
        IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF,
        IPC_CHANNELS.ORCHESTRATION_SNAPSHOT,
      ].sort()
    );
  });

  it.each([42, '', null, '../settings.json', 'C:\\repos\\x', { id: WORKSPACE_ID }])(
    'snapshot 拒绝非法工作区 id %j',
    async (raw) => {
      expect(await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, raw)).toEqual({
        ok: false,
        error: '无效的工作区 id',
      });
    }
  );

  it('snapshot：未知工作区返回错误；已挂入的返回磁盘上的编排状态（不含 version）', async () => {
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, 'ws-unknown')).toEqual({
      ok: false,
      error: '工作区不存在',
    });
    const { version: _version, ...view } = SNAPSHOT;
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, WORKSPACE_ID)).toEqual({
      ok: true,
      ...view,
    });
  });

  it.each([
    undefined,
    DISPATCH_ID,
    { dispatchId: DISPATCH_ID },
    { dispatchId: DISPATCH_ID, cursor: -1 },
    { dispatchId: DISPATCH_ID, cursor: 1.5 },
    { dispatchId: DISPATCH_ID, cursor: '0' },
    { dispatchId: '../dispatch', cursor: 0 },
    { dispatchId: 'C:\\worktrees\\x', cursor: 0 },
  ])('read-worker-output 拒绝非法入参 %j', async (raw) => {
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, raw)).toEqual({
      ok: false,
      error: '无效的 dispatch id 或 cursor',
    });
  });

  it('read-worker-output：launcher 接线前返回错误；接上后读 dispatch 对应的 worker 会话', async () => {
    const input = { dispatchId: DISPATCH_ID, cursor: 3 };
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected'),
    });

    const { getOrchestrationRegistry } = await import('./orchestration');
    const launcher = createFakeLauncher();
    launcher.readTranscript.mockResolvedValue({ ok: true, text: 'lo', total: 5, done: true });
    getOrchestrationRegistry().setLauncher(launcher);
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, input)).toEqual({
      ok: true,
      text: 'lo',
      total: 5,
      // 这次尝试还没结算
      done: false,
    });
    expect(launcher.readTranscript).toHaveBeenCalledWith('session_w1', 3);
    expect(
      await invoke(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, {
        dispatchId: 'dispatch_missing',
        cursor: 0,
      })
    ).toEqual({ ok: false, error: 'dispatch 不存在' });
  });

  it('review-diff：校验 id；worktree 目录不在时返回 git 的错误而不是抛异常', async () => {
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF, 42)).toEqual({
      ok: false,
      error: '无效的 dispatch id',
    });
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF, 'dispatch_missing')).toEqual({
      ok: false,
      error: 'dispatch 不存在',
    });
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF, DISPATCH_ID)).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not read the diff'),
    });
  });

  it.each([
    null,
    WORKSPACE_ID,
    [],
    { workspaceId: WORKSPACE_ID, cwd: '/tmp' },
    { workspaceId: WORKSPACE_ID, path: '/tmp' },
    { workspaceId: WORKSPACE_ID, branch: 'main' },
    { workspaceId: WORKSPACE_ID, sessionId: '../escape' },
    { workspaceId: WORKSPACE_ID, sessionId: null },
  ])('changes rejects paths, unknown keys and invalid ids: %j', async (raw) => {
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_CHANGES, raw)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid changes request'),
    });
  });

  it('changes reads the registered main directory through the typed IPC result', async () => {
    expect(
      await invoke(IPC_CHANNELS.ORCHESTRATION_CHANGES, { workspaceId: WORKSPACE_ID })
    ).toMatchObject({
      ok: true,
      availability: 'available',
      branch: 'main',
      headCommit: null,
      comparison: { kind: 'unborn' },
      uncommitted: {
        available: true,
        files: ['main-draft.txt'],
        diff: expect.stringContaining('+main changes'),
      },
    });
  });

  it('changes resolves ids without starting a session and reports missing registrations', async () => {
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_CHANGES, { workspaceId: 'missing' })).toEqual({
      ok: false,
      error: 'Workspace not found',
    });
    expect(
      await invoke(IPC_CHANNELS.ORCHESTRATION_CHANGES, {
        workspaceId: WORKSPACE_ID,
        sessionId: 'missing',
      })
    ).toEqual({ ok: false, error: 'Session does not belong to this workspace' });
  });

  it('Tasks refresh exposes persisted missing-worker recovery, with one durable change notification', async () => {
    const { getOrchestrationRegistry } = await import('./orchestration');
    const registry = getOrchestrationRegistry();
    const fork = vi.fn(() => {
      throw new Error('Recovery must not start a worker');
    });
    writeFileSync(
      join(mocks.userData, 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'session_w1',
            workspaceId: WORKSPACE_ID,
            roleId: 'worker',
            title: 'Existing worker',
            cwd: join(mocks.userData, 'repo'),
            status: 'idle',
            createdAt: 1,
            updatedAt: 1,
            approvalMode: 'auto-edits',
          },
        ],
      })
    );
    const sessionStore = createSessionStore({ filePath: join(mocks.userData, 'sessions.json') });
    const host = createAgentHost({
      fork,
      agentDir: join(mocks.userData, 'agent'),
      store: sessionStore,
      roles: createFakeRoles(),
      workspaces: { get: () => undefined },
      models: { resolve: async () => ({ ok: false, error: 'Recovery must not resolve a model' }) },
      broadcast: mocks.send,
    });
    // Earlier output queries may have opened this service while the launcher had no evidence.
    const before = await registry.readSnapshot('ws-orphan');
    expect(before?.tasks[0]?.status).toBe('in-progress');
    mocks.send.mockClear();
    registry.setLauncher(host.implementsLauncher());
    const recovered = await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, 'ws-orphan');
    expect(recovered).toMatchObject({
      ok: true,
      tasks: [{ status: 'failed' }],
      dispatches: [
        {
          id: DISPATCH_ID,
          outcome: 'failed',
          settledAt: expect.any(Number),
          summary: expect.stringContaining('missing from the session registry'),
        },
      ],
      worktrees: before?.worktrees,
    });
    await registry.flushAll();
    const statePath = join(mocks.userData, 'orchestration', 'ws-orphan.json');
    const persisted = readFileSync(statePath, 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({
      tasks: [{ status: 'failed' }],
      dispatches: [{ outcome: 'failed' }],
    });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.ORCHESTRATION_CHANGED,
      'ws-orphan'
    );
    mocks.send.mockClear();
    expect(await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, 'ws-orphan')).toEqual(recovered);
    await registry.flushAll();
    expect(readFileSync(statePath, 'utf8')).toBe(persisted);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it('编排状态变更后按 workspaceId 广播 orchestration:changed', async () => {
    const { getOrchestrationRegistry } = await import('./orchestration');
    await getOrchestrationRegistry().openAll();
    mocks.send.mockClear();
    const worker = getOrchestrationRegistry().workerHostFor('session_w1');
    expect(await worker?.reportDone('succeeded', 'Done.')).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.ORCHESTRATION_CHANGED, WORKSPACE_ID);
    const snapshot = await invoke(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, WORKSPACE_ID);
    expect(snapshot).toMatchObject({ ok: true, tasks: [{ status: 'in-review' }] });
  });
});
