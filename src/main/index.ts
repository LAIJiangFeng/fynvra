import { join, resolve } from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { errorMessage } from '@shared/guards';
import { app, BrowserWindow, dialog } from 'electron';
import { configureMainLocale, translate } from './i18n';
import { registerIpcHandlers } from './ipc';
import { getOrchestrationRegistry } from './ipc/orchestration';
import { getAgentHost } from './ipc/sessions';
import { getSettingsFile } from './ipc/settings';
import { connectOrchestration } from './services/agentHost/connectOrchestration';
import { installCoordinatorWake } from './services/agentHost/coordinatorWake';
import { getUpdateService } from './services/updates';
import { createAppWindow } from './windows/createAppWindow';
import { createQuitGuard } from './windows/quitGuard';

/** 退出时等 agent worker 关闭会话（MCP 连接、bash 进程组）的上限 */
const AGENT_SHUTDOWN_TIMEOUT_MS = 5_000;

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
let quitGuard: ReturnType<typeof createQuitGuard> | undefined;

function showMainWindow(): void {
  if (getUpdateService().getState().status === 'installing') return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow = createAppWindow({ width: 1280, height: 800, minWidth: 960, minHeight: 600 });
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!event.defaultPrevented) {
      quitGuard?.cancel();
      getUpdateService().cancelInstall();
    }
  });
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
  // Electron 退出时不给 utilityProcess 发 SIGTERM：先让 worker 关闭全部会话再退出，否则命令会成孤儿进程
  quitGuard = createQuitGuard({
    windows: () => BrowserWindow.getAllWindows(),
    quit: () => app.quit(),
    completeQuit: () => {
      const updates = getUpdateService();
      if (updates.finishInstall()) return;
      app.quit();
    },
    mac: process.platform === 'darwin',
    shutdown: () =>
      getAgentHost()
        .shutdown(AGENT_SHUTDOWN_TIMEOUT_MS)
        // 编排状态每次变更都已在一个微任务里写盘，这里等最后一次写完
        .then(() => getOrchestrationRegistry().flushAll())
        .catch((error: unknown) => console.error('[fynvra] 退出前收尾失败', error)),
  });
  app.on('before-quit', quitGuard.beforeQuit);
  app.on('window-all-closed', quitGuard.allWindowsClosed);
  app.on('will-quit', () => getUpdateService().stop());

  app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('com.fynvra.app');
      // Main 的文案按设置里的界面语言；跟随系统时与 Renderer 一样先看应用 locale（navigator.languages 由它而来）
      const systemLanguages = [app.getLocale(), ...app.getPreferredSystemLanguages()];
      configureMainLocale({
        language: () => getSettingsFile().read().preferences.language,
        systemLanguages: () => systemLanguages,
        warnMissing: !app.isPackaged,
      });
      registerIpcHandlers();
      const agentHost = getAgentHost();
      // worker 会话由 agent host 启动，编排 / worker 工具经注册表找到 Host；
      // 启动或恢复任何会话之前先加载全部工作区的编排快照
      await connectOrchestration(agentHost, getOrchestrationRegistry());
      // 主 agent 派发后不阻塞等待：worker 汇报到达且主 agent 空闲时自动唤醒它
      installCoordinatorWake({ agentHost, registry: getOrchestrationRegistry() });
      agentHost.start();
      showMainWindow();
      getUpdateService().start();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(translate('app.startFailed'), errorMessage(error));
      app.quit();
    });
}
