import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  type PickWorktreesRootResult,
  parseSettings,
  type WorktreesRootInfoResult,
} from '@shared/types/settings';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appListeners: new Map<string, () => void>(),
  send: vi.fn(),
  showOpenDialog: vi.fn(),
  nativeTheme: { themeSource: 'light', shouldUseDarkColors: false },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    on: (event: string, listener: () => void) => mocks.appListeners.set(event, listener),
  },
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
  nativeTheme: mocks.nativeTheme,
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

let base: string;
let repoPath: string;

const pick = (dir: string | null) =>
  mocks.showOpenDialog.mockResolvedValueOnce(
    dir ? { canceled: false, filePaths: [dir] } : { canceled: true, filePaths: [] }
  );
const pickRoot = async (input?: unknown) =>
  (await (input === undefined
    ? invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT)
    : invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT, input))) as PickWorktreesRootResult;
const rootInfo = async (input?: unknown) =>
  (await (input === undefined
    ? invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO)
    : invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO, input))) as WorktreesRootInfoResult;
const preferences = () =>
  (invoke(IPC_CHANNELS.SETTINGS_GET) as { preferences: Record<string, unknown> }).preferences;

beforeAll(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fynvra-ipc-settings-')));
  mocks.userData = join(base, 'userData');
  repoPath = join(base, 'project', 'app');
  mkdirSync(join(mocks.userData, 'orchestration'), { recursive: true });
  writeFileSync(
    join(mocks.userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      preferences: {},
      workspaces: [{ id: 'ws-1', name: 'app', repoPath, defaultBranch: 'main' }],
    })
  );
  // 编排快照登记了两个 worktree：一个在磁盘上（8 字节），一个已经被手动删掉
  mkdirSync(join(base, 'wt-a', 'src'), { recursive: true });
  writeFileSync(join(base, 'wt-a', 'a.txt'), '123');
  writeFileSync(join(base, 'wt-a', 'src', 'b.ts'), '12345');
  const worktree = (id: string, path: string) => ({
    id,
    workspaceId: 'ws-1',
    path,
    branch: `fynvra/${id}`,
    baseRef: 'main',
    baseCommit: 'abc1234',
  });
  writeFileSync(
    join(mocks.userData, 'orchestration', 'ws-1.json'),
    JSON.stringify({
      version: 1,
      runs: [],
      tasks: [],
      dispatches: [],
      worktrees: [worktree('wt_a', join(base, 'wt-a')), worktree('wt_b', join(base, 'wt-gone'))],
      messages: [],
    })
  );
  const { registerSettingsHandlers } = await import('./settings');
  registerSettingsHandlers();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('settings IPC', () => {
  it('注册时按已存偏好同步原生主题，settings:get 返回默认偏好', () => {
    expect(mocks.nativeTheme.themeSource).toBe('system');
    expect(invoke(IPC_CHANNELS.SETTINGS_GET)).toEqual({
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true },
    });
  });

  it.each([
    null,
    'dark',
    [{ theme: 'dark' }],
    { theme: 'neon' },
    { sidePanelOpen: 1 },
    { sidebarOpen: 'false' },
    { theme: 'dark', workspaces: [{ repoPath: 'C:\\' }] },
    { worktreesRoot: 'D:\\wt' },
  ])('settings:update 拒绝非法入参 %j，不抛异常也不改动设置', (raw) => {
    expect(invoke(IPC_CHANNELS.SETTINGS_UPDATE, raw)).toMatchObject({ ok: false });
    expect(invoke(IPC_CHANNELS.SETTINGS_GET)).toMatchObject({
      preferences: { theme: 'system', sidePanelOpen: true },
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('settings:update 合并偏好、同步原生主题、广播变更，退出前落盘', () => {
    expect(invoke(IPC_CHANNELS.SETTINGS_UPDATE, { theme: 'dark' })).toEqual({
      ok: true,
      preferences: { theme: 'dark', sidePanelOpen: true },
    });
    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

    mocks.appListeners.get('before-quit')?.();
    const disk = JSON.parse(readFileSync(join(mocks.userData, 'settings.json'), 'utf8'));
    expect(disk.preferences).toEqual({ theme: 'dark', sidePanelOpen: true });
  });

  it('内容未变化的更新不广播', () => {
    mocks.send.mockClear();
    expect(invoke(IPC_CHANNELS.SETTINGS_UPDATE, { theme: 'dark' })).toMatchObject({ ok: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('settings:update 记下左栏开合并落盘，重启后读回', () => {
    mocks.send.mockClear();
    expect(invoke(IPC_CHANNELS.SETTINGS_UPDATE, { sidebarOpen: false })).toEqual({
      ok: true,
      preferences: { theme: 'dark', sidePanelOpen: true, sidebarOpen: false },
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

    mocks.appListeners.get('before-quit')?.();
    const disk = JSON.parse(readFileSync(join(mocks.userData, 'settings.json'), 'utf8'));
    expect(disk.preferences).toEqual({ theme: 'dark', sidePanelOpen: true, sidebarOpen: false });
    expect(parseSettings(disk).preferences.sidebarOpen).toBe(false);
  });
});

describe('worktree 根目录 IPC', () => {
  beforeEach(() => {
    mocks.send.mockClear();
    mocks.showOpenDialog.mockReset();
  });

  it.each([
    ['路径字符串', 'D:\\wt'],
    ['带路径的对象', { path: 'D:\\wt' }],
    ['类型不符', { reset: 'yes' }],
    ['null', null],
  ])('pick-worktrees-root 拒绝 %s：不弹框、不写入', async (_label, raw) => {
    expect(await pickRoot(raw)).toMatchObject({ ok: false, code: 'invalid' });
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(preferences()).not.toHaveProperty('worktreesRoot');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('取消选择时什么都不改', async () => {
    pick(null);
    expect(await pickRoot()).toMatchObject({ ok: false, code: 'canceled' });
    expect(preferences()).not.toHaveProperty('worktreesRoot');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('选中已挂入仓库里的目录：返回校验错误，不写入', async () => {
    pick(join(repoPath, 'worktrees'));
    const result = await pickRoot();
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid',
      error: expect.stringContaining(repoPath),
    });
    expect(preferences()).not.toHaveProperty('worktreesRoot');
  });

  it('默认位置：info 给出仓库同级目录与登记数；{ usage: false } 不统计占用', async () => {
    const result = await rootInfo({ usage: false });
    expect(result).toEqual({
      ok: true,
      info: {
        isDefault: true,
        fallbackRoot: join(mocks.userData, 'worktrees'),
        workspaces: [
          {
            workspaceId: 'ws-1',
            name: 'app',
            root: join(base, 'project', 'app-worktrees'),
            count: 2,
          },
        ],
      },
    });
    expect(await rootInfo({ usage: 'yes' })).toMatchObject({ ok: false });
  });

  it('默认统计占用：已有 worktree 的大小与已不存在的个数', async () => {
    const result = await rootInfo();
    expect(result.ok && result.info.workspaces[0]?.usage).toEqual({ bytes: 8, missing: 1 });
  });

  it('新的占用统计会取消还在进行的那一次', async () => {
    const first = rootInfo();
    const second = rootInfo();
    expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('取消') });
    expect(await second).toMatchObject({ ok: true });
  });

  it('选中合法目录：写入 preferences.worktreesRoot、广播变更；{ reset: true } 恢复默认', async () => {
    const chosen = join(base, 'D-drive', 'worktrees');
    mkdirSync(chosen, { recursive: true });
    pick(chosen);
    const picked = await pickRoot();
    expect(picked).toMatchObject({ ok: true, preferences: { worktreesRoot: chosen } });
    expect(preferences()).toMatchObject({ worktreesRoot: chosen });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

    const info = await rootInfo({ usage: false });
    expect(info.ok && info.info).toMatchObject({
      isDefault: false,
      worktreesRoot: chosen,
      workspaces: [{ root: join(chosen, 'app') }],
    });

    mocks.send.mockClear();
    expect(await pickRoot({ reset: true })).toMatchObject({ ok: true });
    expect(preferences()).not.toHaveProperty('worktreesRoot');
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
    expect(mocks.showOpenDialog).toHaveBeenCalledTimes(1);
  });
});
