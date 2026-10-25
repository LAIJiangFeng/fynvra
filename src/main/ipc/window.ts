import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { BrowserWindow, ipcMain } from 'electron';
import { translate } from '../i18n';

/** 自绘标题栏的窗口控制：一律作用于发起调用的窗口。 */
export function registerWindowHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) =>
    withSenderWindow(event, (win) => win.minimize())
  );

  ipcMain.handle(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, (event) =>
    withSenderWindow(event, (win) => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  );

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) =>
    withSenderWindow(event, (win) => win.close())
  );

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (event): IpcResult<{ maximized: boolean }> => {
    const win = senderWindow(event);
    return win
      ? { ok: true, maximized: win.isMaximized() }
      : { ok: false, error: translate('common.windowClosed') };
  });
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

function withSenderWindow(
  event: Electron.IpcMainInvokeEvent,
  action: (win: BrowserWindow) => void
): IpcResult {
  const win = senderWindow(event);
  if (!win) return { ok: false, error: translate('common.windowClosed') };
  action(win);
  return { ok: true };
}
