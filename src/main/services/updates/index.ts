import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { translate } from '../../i18n';
import { showAppMessageBox } from '../../ipc/appDialog';
import { sendToAllWindows } from '../../windows/createAppWindow';
import { showDesktopNotification } from '../notifications/desktop';
import { updateUnavailableReason } from './platform';
import { createUpdateService, type UpdateService } from './service';

let service: UpdateService | undefined;

function macUpdateMode(): unknown {
  if (process.platform !== 'darwin' || !app.isPackaged) return undefined;
  try {
    return asRecord(JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')))
      ?.fynvraMacUpdateMode;
  } catch {
    // 缺失或损坏的打包标记不能放行原生更新安装。
    return undefined;
  }
}

export function getUpdateService(): UpdateService {
  service ??= createUpdateService({
    updater: electronUpdater.autoUpdater,
    currentVersion: app.getVersion(),
    unavailableReason: updateUnavailableReason(
      app.isPackaged,
      process.platform,
      process.arch,
      macUpdateMode()
    ),
    broadcast: (state) => sendToAllWindows(IPC_CHANNELS.UPDATES_CHANGED, state),
    notify: (version) =>
      showDesktopNotification({
        title: 'Fynvra',
        body: translate('updates.downloaded', { version }),
        silent: true,
      }),
    // 先让 IPC 的确认结果返回，再触发窗口退出。
    requestQuit: () => setImmediate(() => app.quit()),
    installFailed: (error) => {
      // 有窗口时用应用内对话框（收不到 ack 会自动回退原生）；窗口已全部关闭时仍用原生错误框。
      const win =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      const quit = () => setImmediate(() => app.quit());
      if (!win) {
        dialog.showErrorBox(translate('updates.installFailed'), error);
        quit();
        return;
      }
      void showAppMessageBox(win, {
        type: 'error',
        message: translate('updates.installFailed'),
        detail: error,
        buttons: [translate('common.ok')],
        defaultId: 0,
        cancelId: 0,
      })
        .catch(() => 0)
        .then(quit);
    },
  });
  return service;
}
