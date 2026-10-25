import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getState: vi.fn(),
  check: vi.fn(),
  requestInstall: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  dialog: { showMessageBox: mocks.confirm },
}));
vi.mock('../services/updates', () => ({ getUpdateService: () => mocks }));

import { registerUpdateHandlers } from './updates';

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);

describe('更新 IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({
      seq: 1,
      status: 'downloaded',
      currentVersion: '0.1.0',
      version: '0.1.1',
    });
    mocks.requestInstall.mockReturnValue(true);
    registerUpdateHandlers();
  });
  it('拒绝版本、路径、URL 等任意入参', async () => {
    for (const channel of [
      IPC_CHANNELS.UPDATES_STATE,
      IPC_CHANNELS.UPDATES_CHECK,
      IPC_CHANNELS.UPDATES_INSTALL,
    ]) {
      for (const input of [undefined, null, 'https://example.com/update.exe', { path: 'bad' }]) {
        expect(await invoke(channel, input)).toMatchObject({ ok: false });
      }
    }
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('取消安装不退出，确认后才请求退出', async () => {
    mocks.confirm.mockResolvedValueOnce({ response: 1 });
    expect(await invoke(IPC_CHANNELS.UPDATES_INSTALL)).toMatchObject({ ok: true });
    expect(mocks.requestInstall).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValueOnce({ response: 0 });
    expect(await invoke(IPC_CHANNELS.UPDATES_INSTALL)).toMatchObject({ ok: true });
    expect(mocks.requestInstall).toHaveBeenCalledOnce();
  });
  it('未下载不允许安装，确认框防重复，异常不跨 IPC 抛出', async () => {
    mocks.getState.mockReturnValueOnce({ status: 'downloading' });
    expect(await invoke(IPC_CHANNELS.UPDATES_INSTALL)).toMatchObject({ ok: false });
    expect(mocks.confirm).not.toHaveBeenCalled();
    let done!: (value: { response: number }) => void;
    mocks.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        })
    );
    const first = invoke(IPC_CHANNELS.UPDATES_INSTALL);
    expect(await invoke(IPC_CHANNELS.UPDATES_INSTALL)).toMatchObject({ ok: false });
    done({ response: 1 });
    await first;
    mocks.check.mockImplementationOnce(() => {
      throw new Error('网络故障');
    });
    expect(await invoke(IPC_CHANNELS.UPDATES_CHECK)).toEqual({ ok: false, error: '网络故障' });
  });
});
