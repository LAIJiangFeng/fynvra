import { IPC_CHANNELS, type IpcResult, type WindowCloseAction } from '@shared/types/ipc';
import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import appIcon from '../../../resources/icon.png?asset';
import { translate } from '../i18n';

const responders = new WeakMap<BrowserWindow, (action: WindowCloseAction) => IpcResult>();

export function respondToClose(win: BrowserWindow, action: WindowCloseAction): IpcResult {
  return responders.get(win)?.(action) ?? { ok: false, error: translate('common.windowClosed') };
}

/** Main 保留窗口控制权；Renderer 只展示选择，明确退出仍走原有保护。 */
export function registerCloseBehavior(win: BrowserWindow, isQuitRequested: () => boolean): void {
  let pending = false;
  let tray: Tray | undefined;
  const show = () => {
    if (win.isDestroyed() || isQuitRequested()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  const hideToTray = () => {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 }));
      tray.setToolTip('Fynvra');
      tray.on('click', show);
      tray.on('double-click', show);
    }
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: translate('app.showWindow'), click: show },
        { type: 'separator' },
        {
          label: translate('app.quit'),
          click: () => {
            show();
            app.quit();
          },
        },
      ])
    );
    // 只有托盘和恢复入口就绪后才能隐藏，创建失败时窗口仍可用。
    win.hide();
  };

  responders.set(win, (action) => {
    if (!pending || win.isDestroyed() || isQuitRequested()) return { ok: true };
    try {
      if (action === 'tray') hideToTray();
      pending = false;
      if (action === 'quit') app.quit();
      return { ok: true };
    } catch (error: unknown) {
      pending = true;
      console.error('[fynvra] 关闭窗口失败', error);
      return { ok: false, error: translate('app.closeFailed') };
    }
  });
  win.on('close', (event) => {
    if (isQuitRequested()) return;
    event.preventDefault();
    pending = true;
    show();
    // 重复通知只打开同一个受控 Dialog；Renderer 重载后也能再次关窗。
    win.webContents.send(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED);
  });
  win.once('closed', () => {
    responders.delete(win);
    tray?.destroy();
  });
}
