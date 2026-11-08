import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { parseRemotePluginSource } from '@shared/types/plugins';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import type {
  PluginAddResult,
  PluginListResult,
  PluginRemoveResult,
  PluginToggleResult,
} from '../../preload/domains/plugins';
import { translate } from '../i18n';
import { createPluginRegistry, type PluginRegistry } from '../services/plugins/pluginRegistry';
import {
  inspectLocalPlugin,
  loadPackageManager,
  PLUGIN_FILE_EXTENSIONS,
  packageManagerError,
  pluginName,
} from '../services/plugins/pluginSources';
import { isRegistryId } from '../services/providers/jsonRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';
import { showAppMessageBox } from './appDialog';

let registry: PluginRegistry | null = null;

/** Main 唯一的 plugins.json 句柄；会话按角色的 pluginIds 取插件路径也走这里。 */
export function getPluginRegistry(): PluginRegistry {
  registry ??= createPluginRegistry({ filePath: join(app.getPath('userData'), 'plugins.json') });
  return registry;
}

/** 与会话相同的 pi agentDir（见 ipc/sessions.ts） */
function agentDir(): string {
  return join(app.getPath('userData'), 'agent');
}

/** 安装 / 卸载（以及登记本地插件）同一时刻只跑一个；进行中再来的请求直接返回 busy */
let busy = false;

async function exclusive<T>(onBusy: () => T, task: () => Promise<T>): Promise<T> {
  if (busy) return onBusy();
  busy = true;
  try {
    return await task();
  } finally {
    busy = false;
  }
}

export function registerPluginHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PLUGINS_LIST, async (): Promise<PluginListResult> => {
    try {
      return { ok: true, plugins: await getPluginRegistry().list() };
    } catch (error) {
      return { ok: false, error: translate('plugins.readFailed', { error: errorMessage(error) }) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_ADD_LOCAL,
    async (event, raw: unknown): Promise<PluginAddResult> => {
      if (raw !== undefined) {
        return { ok: false, code: 'invalid', error: translate('common.invalidArgs') };
      }
      return exclusive(busyResult, async () => {
        try {
          return await addLocal(event.sender);
        } catch (error) {
          return { ok: false, code: 'failed', error: errorMessage(error) };
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_INSTALL,
    async (_event, raw: unknown): Promise<PluginAddResult> => {
      const record = asRecord(raw);
      const parsed =
        record && Object.keys(record).every((key) => key === 'source')
          ? parseRemotePluginSource(record.source)
          : null;
      if (!parsed) return { ok: false, code: 'invalid', error: translate('plugins.invalidSource') };
      return exclusive(busyResult, async () => {
        try {
          return await installRemote(parsed.source, parsed.kind);
        } catch (error) {
          return { ok: false, code: 'failed', error: errorMessage(error) };
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_REMOVE,
    async (_event, rawId: unknown): Promise<PluginRemoveResult> => {
      if (!isRegistryId(rawId)) {
        return { ok: false, code: 'invalid', error: translate('plugins.invalidId') };
      }
      return exclusive(busyResult, async () => {
        try {
          return await removePlugin(rawId);
        } catch (error) {
          return {
            ok: false,
            code: 'failed',
            error: translate('plugins.removeFailed', { error: errorMessage(error) }),
          };
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_TOGGLE,
    async (_event, raw: unknown): Promise<PluginToggleResult> => {
      const input = parseToggle(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      try {
        const plugin = await getPluginRegistry().setEnabled(input.id, input.enabled);
        if (!plugin) return { ok: false, error: translate('plugins.notFound') };
        sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
        return { ok: true, plugin };
      } catch (error) {
        return {
          ok: false,
          error: translate('plugins.updateFailed', { error: errorMessage(error) }),
        };
      }
    }
  );
}

function busyResult(): { ok: false; code: 'busy'; error: string } {
  return { ok: false, code: 'busy', error: translate('plugins.busy') };
}

async function addLocal(sender: Electron.WebContents): Promise<PluginAddResult> {
  const picked = await pickLocalPlugin(sender);
  if (!picked) return { ok: false, code: 'canceled', error: translate('common.canceled') };
  const checked = await inspectLocalPlugin(picked);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const added = await getPluginRegistry().add({
    name: checked.name,
    source: checked.path,
    kind: 'local',
    path: checked.path,
  });
  if (!added.ok) return { ok: false, code: 'invalid', error: added.error };
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: added.plugin };
}

async function installRemote(source: string, kind: 'npm' | 'git'): Promise<PluginAddResult> {
  const plugins = getPluginRegistry();
  const duplicate = await plugins.findDuplicate({ source });
  if (duplicate) {
    return {
      ok: false,
      code: 'invalid',
      error: translate('plugins.alreadyRegistered', { name: duplicate.name }),
    };
  }
  const manager = await loadPackageManager(agentDir());
  try {
    await manager.install(source);
  } catch (error) {
    return {
      ok: false,
      code: 'failed',
      error: translate('plugins.installFailed', { error: packageManagerError(error, kind) }),
    };
  }
  const path = manager.getInstalledPath(source, 'user');
  if (!path) return { ok: false, code: 'failed', error: translate('plugins.installedPathMissing') };
  const added = await plugins.add({ name: await pluginName(path), source, kind, path });
  if (!added.ok) return { ok: false, code: 'invalid', error: added.error };
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: added.plugin };
}

/** 本地插件只删登记，绝不删除用户的目录或文件；npm / git 插件先经 pi 卸载，成功后再删登记。 */
async function removePlugin(id: string): Promise<PluginRemoveResult> {
  const plugins = getPluginRegistry();
  const plugin = await plugins.get(id);
  if (!plugin) return { ok: false, code: 'invalid', error: translate('plugins.notFound') };
  if (plugin.kind !== 'local') {
    const manager = await loadPackageManager(agentDir());
    try {
      await manager.remove(plugin.source);
    } catch (error) {
      return {
        ok: false,
        code: 'failed',
        error: translate('plugins.uninstallFailed', {
          error: packageManagerError(error, plugin.kind),
        }),
      };
    }
  }
  await plugins.remove(id);
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true };
}

function parseToggle(raw: unknown): { id: string; enabled: boolean } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id' && key !== 'enabled')) return null;
  const { id, enabled } = record;
  return isRegistryId(id) && typeof enabled === 'boolean' ? { id, enabled } : null;
}

/**
 * 选插件目录或单个扩展文件。macOS 的打开框能同时选文件和目录；Windows / Linux 不行，先问选哪种。
 */
async function pickLocalPlugin(sender: Electron.WebContents): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  let properties: OpenDialogOptions['properties'] = ['openFile', 'openDirectory'];
  if (process.platform !== 'darwin') {
    const ask: MessageBoxOptions = {
      type: 'question',
      message: translate('plugins.pickKind'),
      buttons: [
        translate('plugins.pickKindDir'),
        translate('plugins.pickKindFile'),
        translate('common.cancel'),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const response = await showAppMessageBox(win, ask);
    if (response === 2) return null;
    properties = response === 0 ? ['openDirectory'] : ['openFile'];
  }
  const options: OpenDialogOptions = {
    title: translate('plugins.pickTitle'),
    buttonLabel: translate('common.add'),
    properties,
    ...(properties.includes('openFile')
      ? {
          filters: [
            { name: translate('plugins.fileFilter'), extensions: [...PLUGIN_FILE_EXTENSIONS] },
          ],
        }
      : {}),
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
