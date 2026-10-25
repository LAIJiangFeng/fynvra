import { type BrowserWindow, dialog } from 'electron';
import { translate } from '../i18n';

export function registerFileUnloadGuard(win: BrowserWindow): void {
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: translate('files.unsavedTitle'),
      message: translate('files.unsavedMessage'),
      detail: translate('files.unsavedDetail'),
      buttons: [translate('common.cancel'), translate('files.discard')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    // 此事件中 preventDefault 表示允许离开，只有明确放弃才调用。
    if (choice === 1) event.preventDefault();
  });
}
