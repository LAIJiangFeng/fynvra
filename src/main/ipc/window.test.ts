import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  respond: vi.fn<() => IpcResult>(() => ({ ok: true })),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: { handle: mocks.handle },
}));
vi.mock('../windows/closeBehavior', () => ({ respondToClose: mocks.respond }));

import { registerWindowHandlers } from './window';

beforeEach(() => {
  vi.clearAllMocks();
  registerWindowHandlers();
});
const handler = (channel: string) =>
  mocks.handle.mock.calls.find(([name]) => name === channel)?.[1];

describe('窗口关闭 IPC', () => {
  it('标题栏关闭仍走 BrowserWindow.close；弹窗答复只作用于 sender 对应窗口', () => {
    const event = { sender: {} };
    const win = { isDestroyed: () => false, close: vi.fn() };
    mocks.fromWebContents.mockReturnValue(win);
    expect(handler(IPC_CHANNELS.WINDOW_CLOSE)(event)).toEqual({ ok: true });
    expect(win.close).toHaveBeenCalledOnce();
    for (const action of ['cancel', 'tray', 'quit']) {
      expect(handler(IPC_CHANNELS.WINDOW_RESPOND_CLOSE)(event, action)).toEqual({ ok: true });
      expect(mocks.respond).toHaveBeenLastCalledWith(win, action);
    }
    expect(mocks.fromWebContents).toHaveBeenLastCalledWith(event.sender);
  });

  it.each([undefined, null, 1, true, 'exit', '', {}, { action: 'quit' }, ['quit']])(
    '拒绝未收窄的关闭操作 %j',
    (raw) => {
      expect(handler(IPC_CHANNELS.WINDOW_RESPOND_CLOSE)({ sender: {} }, raw)).toMatchObject({
        ok: false,
      });
      expect(mocks.respond).not.toHaveBeenCalled();
    }
  );

  it.each([null, { isDestroyed: () => true }])('找不到存活窗口时拒绝答复', (win) => {
    mocks.fromWebContents.mockReturnValue(win);
    expect(handler(IPC_CHANNELS.WINDOW_RESPOND_CLOSE)({ sender: {} }, 'quit')).toMatchObject({
      ok: false,
    });
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it('把 Main 的失败返回给 Renderer，不伪报成功', () => {
    mocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    mocks.respond.mockReturnValueOnce({ ok: false, error: '托盘不可用' });
    expect(handler(IPC_CHANNELS.WINDOW_RESPOND_CLOSE)({ sender: {} }, 'tray')).toEqual({
      ok: false,
      error: '托盘不可用',
    });
  });
});
