import type { BrowserWindow } from 'electron';
import { prepareWorkspaceWindowClose } from '../ipc/workspaceUi';

/** Normal quit is prepared by quitGuard. A reload must also wait for durable UI state. */
export function registerFileUnloadGuard(win: BrowserWindow): void {
  win.webContents.on('will-prevent-unload', () => {
    // Keep the original navigation canceled; retry only after the async acknowledgement.
    void prepareWorkspaceWindowClose(win).then((ok) => {
      if (ok && !win.isDestroyed()) win.webContents.reload();
    });
  });
}
