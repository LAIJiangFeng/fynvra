import { join, resolve } from 'node:path';
import { optimizer } from '@electron-toolkit/utils';
import { ORCHESTRATOR_ROLE_ID } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { watchdogPreferencesOf } from '@shared/types/settings';
import { app, BrowserWindow, dialog, session } from 'electron';
import appIcon from '../../resources/icon.png?asset';
import { configureMainLocale, translate } from './i18n';
import { registerIpcHandlers } from './ipc';
import { getAppPluginRuntime, shutdownAppPlugins, startAppPlugins } from './ipc/appPlugins';
import { getOrchestrationRegistry } from './ipc/orchestration';
import { getRoleStore } from './ipc/roles';
import { getAgentHost, getSessionAttachments, getSessionStore } from './ipc/sessions';
import { getSettingsFile } from './ipc/settings';
import { getWorkspaceService } from './ipc/workspaces';
import { getWorkspaceUiService, prepareWorkspaceWindowClose } from './ipc/workspaceUi';
import { connectOrchestration } from './services/agentHost/connectOrchestration';
import { installCoordinatorWake } from './services/agentHost/coordinatorWake';
import { installSessionWatchdog } from './services/agentHost/watchdog';
import { createCleanCheckout } from './services/channels/cleanCheckout';
import { createChannelHost } from './services/channels/host';
import { setChannelHost } from './services/channels/instance';
import { collectLocalInfo } from './services/channels/localInfo';
import { createChannelStore } from './services/channels/store';
import { savedCommandEnvironment } from './services/commandNetwork';
import { setPullRequestBodyExtension } from './services/orchestration/pullRequest';
import {
  createWorktreesRootResolver,
  fallbackWorktreesRoot,
} from './services/orchestration/worktreesRoot';
import { collectAppSecrets } from './services/secrets';
import { loadLoginShellPath } from './services/shellEnv';
import { createSystemProxyResolver, setSystemProxy } from './services/systemProxy';
import { getUpdateService } from './services/updates';
import { registerCloseBehavior } from './windows/closeBehavior';
import { createAppWindow } from './windows/createAppWindow';
import { createQuitGuard } from './windows/quitGuard';

/** 退出时等 agent worker 关闭会话（MCP 连接、bash 进程组）的上限 */
const AGENT_SHUTDOWN_TIMEOUT_MS = 5_000;
/** 渠道会话附件副本的定期清理间隔 */
const CHANNEL_COPY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 对所有渠道会话（带 profile）逐个清理附件副本；prune 自身不抛异常 */
async function pruneChannelCopies(): Promise<void> {
  const copies = getSessionAttachments();
  for (const stored of getSessionStore().all()) {
    if (stored.profile) await copies.prune(stored.id);
  }
}

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
  if (quitGuard?.isQuitRequested() || getUpdateService().getState().status === 'installing') return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createAppWindow({ width: 1280, height: 800, minWidth: 960, minHeight: 600 });
  registerCloseBehavior(mainWindow, () => quitGuard?.isQuitRequested() ?? false);
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
  app.on('activate', showMainWindow);
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
    prepare: async () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!(await prepareWorkspaceWindowClose(win))) {
          getUpdateService().cancelInstall();
          return false;
        }
      }
      try {
        await getWorkspaceUiService().flush();
        return true;
      } catch {
        getUpdateService().cancelInstall();
        return false;
      }
    },
    shutdown: () =>
      // Fynvra 插件：逐个 deactivate，5 秒后强杀
      shutdownAppPlugins()
        .catch((error: unknown) => console.error('[fynvra] 停止 Fynvra 插件失败', error))
        .then(() => getAgentHost().shutdown(AGENT_SHUTDOWN_TIMEOUT_MS))
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
      // 先开始读登录 shell 的 PATH，fork worker 之前再等它（失败不抛错）
      const shellPathReady = loadLoginShellPath();
      // toolkit 在 dev 下会改用 electron.exe 的身份；开发版也使用独立的 Fynvra 分组。
      if (process.platform === 'win32')
        app.setAppUserModelId(app.isPackaged ? 'com.fynvra.app' : 'com.fynvra.app.dev');
      if (process.platform === 'darwin') app.dock?.setIcon(appIcon);
      // Main 的文案按设置里的界面语言；跟随系统时与 Renderer 一样先看应用 locale（navigator.languages 由它而来）
      const systemLanguages = [app.getLocale(), ...app.getPreferredSystemLanguages()];
      configureMainLocale({
        language: () => getSettingsFile().read().preferences.language,
        systemLanguages: () => systemLanguages,
        warnMissing: !app.isPackaged,
      });
      registerIpcHandlers();
      // 跟随系统代理：Chromium 按系统代理 / PAC 解析，后台定期刷新；会话启动前最多等 3 秒
      const systemProxy = createSystemProxyResolver({
        resolve: (url) => session.defaultSession.resolveProxy(url),
        log: (message) => console.warn(`[fynvra] ${message}`),
      });
      setSystemProxy(systemProxy);
      const systemProxyReady = systemProxy.start();
      const agentHost = getAgentHost();
      await shellPathReady;
      // worker 会话由 agent host 启动，编排 / worker 工具经注册表找到 Host；
      // 启动或恢复任何会话之前先加载全部工作区的编排快照
      await connectOrchestration(agentHost, getOrchestrationRegistry());
      // 档位会话的 cwd 校验、编排建 worktree 与渠道干净检出用同一套根目录规则
      const listWorkspaces = () => {
        const workspaces = getWorkspaceService();
        return workspaces.list().flatMap((item) => workspaces.get(item.id) ?? []);
      };
      const worktreesRoot = createWorktreesRootResolver({
        fallbackRoot: fallbackWorktreesRoot(app.getPath('userData')),
        configured: () => getSettingsFile().read().preferences.worktreesRoot,
        repoPaths: () => listWorkspaces().map((workspace) => workspace.repoPath),
      });
      agentHost.setWorktreesRootLookup(worktreesRoot);
      // 主 agent 派发后不阻塞等待：worker 汇报到达且主 agent 空闲时自动唤醒它
      installCoordinatorWake({ agentHost, registry: getOrchestrationRegistry() });
      // 渠道插件用的核心能力
      const snapshot = async (workspaceId: string) =>
        getOrchestrationRegistry().serviceFor(workspaceId)?.snapshot();
      const cleanCheckout = createCleanCheckout({
        worktreesRoot,
        commandEnv: savedCommandEnvironment,
      });
      const localInfo = () =>
        collectLocalInfo({
          userDataPath: app.getPath('userData'),
          workspaces: listWorkspaces(),
          worktreesRoot,
        });
      // 渠道宿主：Fynvra 插件经 channel API 用这些能力，只能碰自己拥有的会话 / 工作区 / 任务
      const channelHost = createChannelHost({
        store: createChannelStore({
          filePath: join(app.getPath('userData'), 'fynvra-plugin-sessions.json'),
        }),
        agentHost,
        attachments: getSessionAttachments(),
        workspaces: getWorkspaceService(),
        snapshot,
        cleanCheckout,
        knownSecrets: collectAppSecrets,
        localInfo,
        call: (pluginId, name, args) => getAppPluginRuntime().call(pluginId, name, args),
        emit: (pluginId, event, payload) => getAppPluginRuntime().emit(pluginId, event, payload),
      });
      setChannelHost(channelHost);
      setPullRequestBodyExtension('channel', (taskId) => channelHost.pullRequestNote(taskId));

      // 会话守护（默认关闭）：主 agent 出错或卡住时自动恢复
      installSessionWatchdog({
        agentHost,
        preferences: () => watchdogPreferencesOf(getSettingsFile().read().preferences),
        isOrchestrator: async (session) =>
          session.roleId === ORCHESTRATOR_ROLE_ID ||
          (await getRoleStore().get(session.roleId))?.tools === 'orchestrator',
      });
      await systemProxyReady;
      // 会话启动前读入归属，triage_report 的路由从一开始就准
      await channelHost
        .start()
        .catch((error: unknown) => console.error('[fynvra] 渠道宿主启动失败', error));
      agentHost.start();
      // 会话记录已加载：先清一次渠道副本，之后每 6 小时一次
      void pruneChannelCopies();
      const pruneTimer = setInterval(
        () => void pruneChannelCopies(),
        CHANNEL_COPY_PRUNE_INTERVAL_MS
      );
      pruneTimer.unref();
      app.on('will-quit', () => clearInterval(pruneTimer));
      // Fynvra 插件：每个启用的插件一个后台进程
      void startAppPlugins().catch((error: unknown) =>
        console.error('[fynvra] Fynvra 插件启动失败', error)
      );
      showMainWindow();
      getUpdateService().start();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(translate('app.startFailed'), errorMessage(error));
      app.quit();
    });
}
