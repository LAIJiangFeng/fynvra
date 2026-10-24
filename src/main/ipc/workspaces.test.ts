import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { WorkspaceAddResult, WorkspaceListResult } from '@shared/types/workspace';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
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
  dialog: { showOpenDialog: mocks.showOpenDialog },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}));

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const pick = (dir: string | null) =>
  mocks.showOpenDialog.mockResolvedValueOnce(
    dir ? { canceled: false, filePaths: [dir] } : { canceled: true, filePaths: [] }
  );

describe.skipIf(!hasGit)('workspaces IPC', () => {
  let base: string;
  let previousCeiling: string | undefined;

  beforeAll(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-ipc-workspaces-')));
    mocks.userData = join(base, 'userData');
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
    const { registerWorkspaceHandlers } = await import('./workspaces');
    registerWorkspaceHandlers();
  });

  afterAll(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.send.mockClear();
  });

  const list = async () => (await invoke(IPC_CHANNELS.WORKSPACES_LIST)) as WorkspaceListResult;
  const add = async () => (await invoke(IPC_CHANNELS.WORKSPACES_ADD)) as WorkspaceAddResult;

  it('取消选择目录时什么都不做', async () => {
    pick(null);
    expect(await add()).toMatchObject({ ok: false, code: 'canceled' });
    expect(await list()).toEqual({ ok: true, workspaces: [] });
  });

  it('非 git 目录被拒绝并带提示，不写入列表', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    pick(plain);
    const result = await add();
    expect(result).toMatchObject({ ok: false, code: 'not-git-repo' });
    expect(!result.ok && result.error).toContain('不是 git 仓库');
    expect(await list()).toEqual({ ok: true, workspaces: [] });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('挂入 git 仓库后出现在列表中，Renderer 只拿到 id 与展示路径', async () => {
    const repo = join(base, 'demo-repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    pick(repo);

    const result = await add();
    expect(result).toMatchObject({ ok: true, created: true, workspace: { name: 'demo-repo' } });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACES_CHANGED);

    const listed = await list();
    expect(listed.ok && listed.workspaces).toEqual([result.ok && result.workspace]);
    expect(listed.ok && Object.keys(listed.workspaces[0] ?? {}).sort()).toEqual([
      'defaultBranch',
      'displayPath',
      'id',
      'name',
    ]);
  });

  it.each([42, '', null, '../settings.json', 'C:\\repos\\x'])(
    'workspaces:remove 拒绝非法 id %j',
    async (raw) => {
      expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, raw)).toMatchObject({ ok: false });
      const listed = await list();
      expect(listed.ok && listed.workspaces).toHaveLength(1);
    }
  );

  it('按 id 移除；未知 id 返回错误', async () => {
    expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, 'unknown-id')).toMatchObject({
      ok: false,
    });
    const listed = await list();
    const id = listed.ok ? listed.workspaces[0]?.id : undefined;
    expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, id)).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACES_CHANGED);
    expect(await list()).toEqual({ ok: true, workspaces: [] });
  });
});
