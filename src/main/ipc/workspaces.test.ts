import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { WorkspaceAddResult, WorkspaceListResult } from '@shared/types/workspace';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
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
  dialog: { showOpenDialog: mocks.showOpenDialog, showMessageBox: mocks.showMessageBox },
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

/** 仓库子目录的确认框：0 挂入仓库根目录，1 仍然挂入该子目录，2 取消 */
const answer = (response: 0 | 1 | 2) => mocks.showMessageBox.mockResolvedValueOnce({ response });

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

  const list = async () => (await invoke(IPC_CHANNELS.WORKSPACES_LIST)) as WorkspaceListResult;
  const add = async () => (await invoke(IPC_CHANNELS.WORKSPACES_ADD)) as WorkspaceAddResult;
  const listed = async () => {
    const result = await list();
    return result.ok ? result.workspaces : [];
  };

  beforeEach(async () => {
    for (const workspace of await listed()) {
      await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, workspace.id);
    }
    mocks.send.mockClear();
    mocks.showMessageBox.mockReset();
  });

  const directory = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const gitRepo = (name: string): string => {
    const repo = directory(name);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    return repo;
  };

  it('取消选择目录时什么都不做', async () => {
    pick(null);
    expect(await add()).toMatchObject({ ok: false, code: 'canceled' });
    expect(await listed()).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('普通目录按无 git 挂入：不问用户，视图没有默认分支', async () => {
    pick(directory('plain'));
    const result = await add();
    expect(result).toMatchObject({
      ok: true,
      created: true,
      workspace: { name: 'plain', vcs: 'none' },
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACES_CHANGED);
    const [workspace] = await listed();
    expect(Object.keys(workspace ?? {}).sort()).toEqual(['displayPath', 'id', 'name', 'vcs']);
  });

  it('git 仓库根目录按 git 挂入，Renderer 只拿到 id 与展示路径', async () => {
    pick(gitRepo('demo-repo'));
    const result = await add();
    expect(result).toMatchObject({
      ok: true,
      created: true,
      workspace: { name: 'demo-repo', vcs: 'git', defaultBranch: 'main' },
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    const workspaces = await listed();
    expect(workspaces).toEqual([result.ok && result.workspace]);
    expect(Object.keys(workspaces[0] ?? {}).sort()).toEqual([
      'defaultBranch',
      'displayPath',
      'id',
      'name',
      'vcs',
    ]);
  });

  describe('仓库子目录：先问用户', () => {
    let repo: string;
    let sub: string;

    beforeEach(() => {
      repo = join(base, 'nested');
      sub = join(repo, 'packages', 'app');
      if (!existsSync(join(repo, '.git'))) gitRepo('nested');
      mkdirSync(sub, { recursive: true });
    });

    it('确认框给出仓库根目录与三个选项', async () => {
      answer(2);
      pick(sub);
      await add();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      const [options] = mocks.showMessageBox.mock.calls[0] ?? [];
      expect(options).toMatchObject({
        buttons: ['挂入仓库根目录', '仍然挂入该子目录', '取消'],
        cancelId: 2,
      });
      expect(options.detail).toContain(repo);
    });

    it('「仍然挂入该子目录」：子目录按无 git 挂入', async () => {
      answer(1);
      pick(sub);
      expect(await add()).toMatchObject({
        ok: true,
        created: true,
        workspace: { name: 'app', vcs: 'none' },
      });
      expect((await listed()).map((workspace) => workspace.vcs)).toEqual(['none']);
    });

    it('「挂入仓库根目录」：改挂外层仓库，按 git 挂入', async () => {
      answer(0);
      pick(sub);
      expect(await add()).toMatchObject({
        ok: true,
        created: true,
        workspace: { name: 'nested', vcs: 'git' },
      });
    });

    it('取消：什么都不写入、不广播', async () => {
      answer(2);
      pick(sub);
      expect(await add()).toMatchObject({ ok: false, code: 'canceled' });
      expect(await listed()).toEqual([]);
      expect(mocks.send).not.toHaveBeenCalled();
    });
  });

  it('同一目录重复挂入返回已有记录，不再广播', async () => {
    const dir = directory('again');
    pick(dir);
    const first = await add();
    mocks.send.mockClear();
    pick(dir);
    const again = await add();
    expect(again).toMatchObject({ ok: true, created: false });
    expect(again.ok && first.ok && again.workspace.id).toBe(first.ok && first.workspace.id);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([42, '', null, '../settings.json', 'C:\\repos\\x'])(
    'workspaces:remove 拒绝非法 id %j',
    async (raw) => {
      pick(directory('kept'));
      await add();
      expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, raw)).toMatchObject({ ok: false });
      expect(await listed()).toHaveLength(1);
    }
  );

  it('按 id 移除；未知 id 返回错误', async () => {
    pick(directory('removed'));
    await add();
    mocks.send.mockClear();
    expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, 'unknown-id')).toMatchObject({
      ok: false,
    });
    const id = (await listed())[0]?.id;
    expect(await invoke(IPC_CHANNELS.WORKSPACES_REMOVE, id)).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACES_CHANGED);
    expect(await listed()).toEqual([]);
  });
});
