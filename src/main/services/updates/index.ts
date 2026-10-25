import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { translate } from '../../i18n';
import { sendToAllWindows } from '../../windows/createAppWindow';
import { showDesktopNotification } from '../notifications/desktop';
import { updateUnavailableReason } from './platform';
import { createUpdateService, type UpdateService } from './service';

let service: UpdateService | undefined;

export function getUpdateService(): UpdateService {
  service ??= createUpdateService({
    updater: electronUpdater.autoUpdater,
    currentVersion: app.getVersion(),
    unavailableReason: updateUnavailableReason(app.isPackaged, process.platform, process.arch),
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
      dialog.showErrorBox(translate('updates.installFailed'), error);
      setImmediate(() => app.quit());
    },
  });
  return service;
}
