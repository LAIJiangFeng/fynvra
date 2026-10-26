import { app, type BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';
import appIcon from '../../../resources/icon.png?asset';
import { translate } from '../i18n';

/** 普通关窗先选择；明确退出/更新安装仍交给 quitGuard 和未保存文件保护。 */
export function registerCloseBehavior(win: BrowserWindow, isQuitRequested: () => boolean): void {
  let prompting = false;
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

  win.on('close', (event) => {
    if (isQuitRequested()) return;
    event.preventDefault();
    if (prompting) return;
    prompting = true;
    void dialog
      .showMessageBox(win, {
        type: 'question',
        title: translate('app.closeTitle'),
        message: translate('app.closeMessage'),
        detail: translate('app.closeDetail'),
        buttons: [
          translate('common.cancel'),
          translate('app.minimizeToTray'),
          translate('app.quit'),
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        if (win.isDestroyed() || isQuitRequested()) return;
        if (response === 1) hideToTray();
        else if (response === 2) app.quit();
      })
      .catch((error: unknown) => {
        console.error('[fynvra] 关闭窗口失败', error);
        if (!win.isDestroyed() && !isQuitRequested())
          dialog.showErrorBox(translate('app.closeTitle'), translate('app.closeFailed'));
      })
      .finally(() => {
        prompting = false;
      });
  });
  win.once('closed', () => tray?.destroy());
}
