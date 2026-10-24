import { join, resolve } from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { errorMessage } from '@shared/guards';
import { app, BrowserWindow, dialog } from 'electron';
import { registerIpcHandlers } from './ipc';
import { createAppWindow } from './windows/createAppWindow';

// dev 与打包版分开 userData，开发时不会改坏正式数据。
// FYNVRA_USER_DATA_DIR 只在 dev 生效，供自动化验证使用隔离的数据目录。
if (!app.isPackaged) {
  const override = process.env.FYNVRA_USER_DATA_DIR?.trim();
  app.setPath(
    'userData',
    override ? resolve(override) : join(app.getPath('appData'), 'fynvra-dev')
  );
}

let mainWindow: BrowserWindow | null = null;

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow = createAppWindow({ width: 1280, height: 800, minWidth: 960, minHeight: 600 });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 单实例：两个进程同时写 settings.json 会互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  // dev 下 F12 开关 DevTools；打包后屏蔽刷新快捷键
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });

  app
    .whenReady()
    .then(() => {
      electronApp.setAppUserModelId('com.fynvra.app');
      registerIpcHandlers();
      showMainWindow();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox('Fynvra 启动失败', errorMessage(error));
      app.quit();
    });
}
