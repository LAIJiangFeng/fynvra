import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appListeners: new Map<string, () => void>(),
  send: vi.fn(),
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
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
  nativeTheme: mocks.nativeTheme,
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

beforeAll(async () => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'fynvra-ipc-settings-'));
  const { registerSettingsHandlers } = await import('./settings');
  registerSettingsHandlers();
});

afterAll(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
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
    { theme: 'dark', workspaces: [{ repoPath: 'C:\\' }] },
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
});
