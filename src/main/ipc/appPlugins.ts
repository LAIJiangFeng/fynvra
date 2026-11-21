// Fynvra 插件的 IPC（领域 appPlugins，ARCHITECTURE §7.12「Fynvra 插件」）与 Main 单例。
// 入参一律从 unknown 收窄、拒绝多余键；Renderer 只传 id；安装 / 更新 / 删除 / 复制与 PI 插件共用串行锁。
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorMessage } from '@shared/guards';
import {
  isEmptyAppPluginArgs,
  parseAppPluginIdInput,
  parseAppPluginToggleInput,
} from '@shared/types/appPlugins';
import {
  normalizeUiActionResult,
  parseOpenLinkInput,
  parseUiActionInput,
} from '@shared/types/appPluginUi';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { notificationPreferencesOf } from '@shared/types/settings';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import type {
  AppPluginActionResult,
  AppPluginListResult,
  AppPluginRemoveResult,
  AppPluginUiActionResult,
  AppPluginUiResult,
} from '../../preload/domains/appPlugins';
import { translate } from '../i18n';
import {
  clearUiOnExit,
  createPluginUiStore,
  type PluginUiStore,
} from '../services/appPlugins/api/ui';
import { createPluginLogger } from '../services/appPlugins/logger';
import { createAppPluginRegistry } from '../services/appPlugins/registry';
import { type AppPluginRuntime, createAppPluginRuntime } from '../services/appPlugins/runtime';
import { createPluginSecretStore } from '../services/appPlugins/secrets';
import {
  type AppPluginService,
  createAppPluginService,
  readAppPluginManifest,
} from '../services/appPlugins/service';
import { getChannelHost } from '../services/channels/instance';
import { freshCommandEnvironment } from '../services/commandNetwork';
import { showDesktopNotification } from '../services/notifications/desktop';
import { getTelegramService } from '../services/telegram/instance';
import { sendToAllWindows } from '../windows/createAppWindow';
import { busyResult, exclusive, getPluginMarket, pluginCopyRoot } from './plugins';
import { getSettingsFile } from './settings';
import { getWorkspaceService } from './workspaces';

let instance: {
  service: AppPluginService;
  runtime: AppPluginRuntime;
  uiStore: PluginUiStore;
} | null = null;

function appPlugins() {
  if (instance) return instance;
  const userData = app.getPath('userData');
  const dataRoot = join(userData, 'fynvra-plugin-data');
  const registry = createAppPluginRegistry({ filePath: join(userData, 'fynvra-plugins.json') });
  const secrets = createPluginSecretStore({
    filePath: join(userData, 'fynvra-plugin-secrets.json'),
  });
  const logger = createPluginLogger({ secrets: (id) => secrets.values(id) });
  const onChanged = () => sendToAllWindows(IPC_CHANNELS.APP_PLUGINS_CHANGED);
  const uiStore = createPluginUiStore((id) =>
    sendToAllWindows(IPC_CHANNELS.APP_PLUGINS_UI_CHANGED, { id })
  );
  const runtime = createAppPluginRuntime({
    registry,
    // 动态 import：electronProcess 引用 `?modulePath`，只在真正启动插件时加载
    fork: clearUiOnExit(
      async (options) =>
        (await import('../services/appPlugins/electronProcess')).forkAppPluginHost(options),
      uiStore
    ),
    apiDeps: {
      log: (id, level, message) => logger.write(id, level, message),
      secrets,
      notify: (title, body) => {
        // 同 Telegram：沿用通知偏好的总开关与提示音
        const preferences = notificationPreferencesOf(getSettingsFile().read().preferences);
        if (preferences.enabled)
          showDesktopNotification({ title, body, silent: !preferences.sound });
      },
      commandEnv: freshCommandEnvironment,
      listWorkspaces: () => {
        const workspaces = getWorkspaceService();
        return workspaces.list().flatMap((item) => workspaces.get(item.id) ?? []);
      },
      channel: getChannelHost,
      uiStore,
      legacyTelegram: {
        path: join(userData, 'telegram.json'),
        stopBuiltin: async () => {
          const telegram = getTelegramService();
          if (!telegram) return;
          try {
            const result = await telegram.setEnabled(false);
            if (!result.ok) console.error(`[appPlugins] 停用内置 Telegram 失败：${result.error}`);
            await telegram.stop();
          } catch (error) {
            console.error(`[appPlugins] 停用内置 Telegram 失败：${errorMessage(error)}`);
          }
        },
      },
    },
    dataRoot,
    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    entryPathOf: (record, main) => join(record.path, ...main.split('/')),
    readMain: async (record) => {
      const checked = await readAppPluginManifest(record.path);
      return checked.ok && checked.manifest.id === record.id ? checked.manifest.host.main : null;
    },
    onChanged,
  });
  const service = createAppPluginService({
    registry,
    runtime,
    secrets,
    root: appPluginRoot,
    dataRoot,
    onChanged,
    // shortcut: 渠道宿主接线前删除的插件不会清归属；实际删除都在启动完成后，出问题再改成启动时对账
    onRemoved: async (id) => {
      await getChannelHost()?.removePlugin(id);
    },
  });
  instance = { service, runtime, uiStore };
  // 启动前先登记已有密钥，日志脱敏与出站过滤从一开始就生效
  void secrets.load().catch(() => undefined);
  return instance;
}

/** 包根目录：插件副本根目录的同级 `fynvra-plugins/` */
export function appPluginRoot(): string {
  return join(dirname(pluginCopyRoot()), 'fynvra-plugins');
}

export function getAppPluginService(): AppPluginService {
  return appPlugins().service;
}

/** H2 / H3 用：向运行中的插件推事件、调插件的 handle */
export function getAppPluginRuntime(): AppPluginRuntime {
  return appPlugins().runtime;
}

/** `agentHost.start()` 之后调用 */
export function startAppPlugins(): Promise<void> {
  return appPlugins().runtime.startAll();
}

/** 退出流程里调用：全部 deactivate，5 秒后强杀 */
export function shutdownAppPlugins(): Promise<void> {
  return instance ? instance.runtime.shutdown() : Promise.resolve();
}

type Handler = (sender: Electron.WebContents, raw: unknown) => Promise<unknown>;

export interface AppPluginHandlerDeps {
  service: () => AppPluginService;
  updateViaMarket: (id: string) => Promise<AppPluginActionResult>;
  isPackaged: () => boolean;
  pickDirectory: (sender: Electron.WebContents) => Promise<string | null>;
  exclusive: <T>(onBusy: () => T, task: () => Promise<T>) => Promise<T>;
  uiStore: () => PluginUiStore;
  /** 调插件 handle 注册的方法；不在运行或超时（RPC 默认 30 秒）时 reject */
  callPlugin: (id: string, name: string, args: unknown) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
}

/** handler 表（channel → handler），依赖可注入便于测试 */
export function createAppPluginHandlers(deps: AppPluginHandlerDeps): Record<string, Handler> {
  const invalid = () => ({
    ok: false as const,
    code: 'invalid' as const,
    error: translate('common.invalidArgs'),
  });
  const guarded = <T>(task: () => Promise<T>, onError: (error: unknown) => T) =>
    deps.exclusive<T | ReturnType<typeof busyResult>>(busyResult, async () => {
      try {
        return await task();
      } catch (error) {
        return onError(error);
      }
    });
  const failed = (error: unknown) => ({
    ok: false as const,
    code: 'failed' as const,
    error: errorMessage(error),
  });

  return {
    [IPC_CHANNELS.APP_PLUGINS_LIST]: async (_sender, raw): Promise<AppPluginListResult> => {
      if (!isEmptyAppPluginArgs(raw)) return { ok: false, error: translate('common.invalidArgs') };
      try {
        return { ok: true, plugins: await deps.service().views() };
      } catch (error) {
        return {
          ok: false,
          error: translate('appPlugins.readFailed', { error: errorMessage(error) }),
        };
      }
    },
    [IPC_CHANNELS.APP_PLUGINS_TOGGLE]: async (_sender, raw): Promise<AppPluginActionResult> => {
      const input = parseAppPluginToggleInput(raw);
      if (!input) return invalid();
      try {
        return await deps.service().toggle(input.id, input.enabled);
      } catch (error) {
        return failed(error);
      }
    },
    [IPC_CHANNELS.APP_PLUGINS_REMOVE]: async (_sender, raw): Promise<AppPluginRemoveResult> => {
      const input = parseAppPluginIdInput(raw);
      if (!input) return invalid();
      return guarded(() => deps.service().remove(input.id), failed);
    },
    [IPC_CHANNELS.APP_PLUGINS_UPDATE]: async (_sender, raw): Promise<AppPluginActionResult> => {
      const input = parseAppPluginIdInput(raw);
      if (!input) return invalid();
      return guarded(() => deps.updateViaMarket(input.id), failed);
    },
    [IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV]: async (
      sender,
      raw
    ): Promise<AppPluginActionResult> => {
      if (!isEmptyAppPluginArgs(raw)) return invalid();
      if (deps.isPackaged()) {
        return { ok: false, code: 'invalid', error: translate('appPlugins.devOnly') };
      }
      return guarded(async (): Promise<AppPluginActionResult> => {
        const picked = await deps.pickDirectory(sender);
        if (!picked) return { ok: false, code: 'canceled', error: translate('common.canceled') };
        return deps.service().addLocal(picked);
      }, failed);
    },
    [IPC_CHANNELS.APP_PLUGINS_RECOPY]: async (_sender, raw): Promise<AppPluginActionResult> => {
      const input = parseAppPluginIdInput(raw);
      if (!input) return invalid();
      return guarded(() => deps.service().recopy(input.id), failed);
    },
    [IPC_CHANNELS.APP_PLUGINS_UI_GET]: async (_sender, raw): Promise<AppPluginUiResult> => {
      const input = parseAppPluginIdInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      return { ok: true, ui: deps.uiStore().get(input.id) };
    },
    [IPC_CHANNELS.APP_PLUGINS_UI_ACTION]: async (
      _sender,
      raw
    ): Promise<AppPluginUiActionResult> => {
      const input = parseUiActionInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      try {
        const result = await deps.callPlugin(input.id, 'ui.action', {
          action: input.action,
          ...(input.itemKey !== undefined ? { itemKey: input.itemKey } : {}),
          values: input.values ?? {},
        });
        return normalizeUiActionResult(result);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    [IPC_CHANNELS.APP_PLUGINS_OPEN_LINK]: async (_sender, raw): Promise<IpcResult> => {
      const input = parseOpenLinkInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      try {
        await deps.openExternal(input.url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

async function pickDirectory(sender: Electron.WebContents): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const options: OpenDialogOptions = {
    title: translate('appPlugins.pickTitle'),
    buttonLabel: translate('common.add'),
    properties: ['openDirectory'],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function registerAppPluginHandlers(): void {
  const handlers = createAppPluginHandlers({
    service: getAppPluginService,
    updateViaMarket: (id) => getPluginMarket().updateApp({ id }),
    isPackaged: () => app.isPackaged,
    pickDirectory,
    exclusive,
    uiStore: () => appPlugins().uiStore,
    callPlugin: (id, name, args) => getAppPluginRuntime().call(id, name, args),
    openExternal: (url) => shell.openExternal(url),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, raw: unknown) => handler(event.sender, raw));
  }
}
