import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UpdateResult } from '@shared/types/updates';
import { dialog, ipcMain } from 'electron';
import { translate } from '../i18n';
import { getUpdateService } from '../services/updates';

/** 更新入口不接受 Renderer 指定下载地址、版本或安装命令。 */
export function registerUpdateHandlers(): void {
  let confirming = false;
  for (const [channel, action] of [
    [IPC_CHANNELS.UPDATES_STATE, 'state'],
    [IPC_CHANNELS.UPDATES_CHECK, 'check'],
    [IPC_CHANNELS.UPDATES_INSTALL, 'install'],
  ] as const) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<UpdateResult> => {
      if (args.length > 0) return { ok: false, error: translate('common.invalidArgs') };
      try {
        const service = getUpdateService();
        if (action === 'check') return { ok: true, state: service.check() };
        if (action === 'install') {
          const state = service.getState();
          if (confirming || state.status !== 'downloaded') {
            return { ok: false, error: translate('updates.notReady') };
          }
          confirming = true;
          try {
            const { response } = await dialog.showMessageBox({
              type: 'question',
              title: translate('updates.installTitle'),
              message: translate('updates.installMessage', { version: state.version ?? '' }),
              detail: translate('updates.installDetail'),
              buttons: [translate('updates.install'), translate('common.cancel')],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            if (response === 0 && !service.requestInstall()) {
              return { ok: false, error: translate('updates.notReady') };
            }
          } finally {
            confirming = false;
          }
        }
        return { ok: true, state: service.getState() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  }
}
