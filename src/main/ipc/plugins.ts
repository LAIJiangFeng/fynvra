import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  isPluginMode,
  isPluginProviderName,
  localPluginMode,
  type PluginEntry,
  type PluginMode,
  parseRemotePluginSource,
  type SetPluginProviderMappingInput,
} from '@shared/types/plugins';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
  shell,
} from 'electron';
import type {
  PluginActionResult,
  PluginAddResult,
  PluginListResult,
  PluginOpenAsWorkspaceResult,
  PluginRemoveResult,
  PluginSetProviderMappingResult,
  PluginToggleResult,
} from '../../preload/domains/plugins';
import { translate } from '../i18n';
import { detectVsCode, launchApplication, validCustomAppPath } from '../services/openWith';
import {
  copyDirOf,
  copyPluginInto,
  freeCopyDirName,
  isStrictlyInside,
  removeCopyDir,
  replaceCopy,
} from '../services/plugins/pluginCopies';
import { createPluginRegistry, type PluginRegistry } from '../services/plugins/pluginRegistry';
import {
  inspectLocalPlugin,
  loadPackageManager,
  PLUGIN_FILE_EXTENSIONS,
  packageManagerError,
  pluginName,
} from '../services/plugins/pluginSources';
import { isRegistryId, toSlug, uniqueId } from '../services/providers/jsonRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';
import { showAppMessageBox } from './appDialog';
import { getProviderStore } from './providers';
import { getSettingsFile } from './settings';
import { getWorkspaceService } from './workspaces';

let registry: PluginRegistry | null = null;

/** Main 唯一的 plugins.json 句柄；会话按角色的 pluginIds 取插件路径也走这里。 */
export function getPluginRegistry(): PluginRegistry {
  registry ??= createPluginRegistry({ filePath: join(app.getPath('userData'), 'plugins.json') });
  return registry;
}

/**
 * 本地插件副本根目录：打包版 `~/.fynvra/plugins`，开发版 `~/.fynvra-dev/plugins`；开发版设了
 * FYNVRA_USER_DATA_DIR（自动化隔离）时为 `<userData>/plugin-files`。每个插件一个子目录。
 */
export function pluginCopyRoot(): string {
  if (app.isPackaged) return join(homedir(), '.fynvra', 'plugins');
  if (process.env.FYNVRA_USER_DATA_DIR?.trim()) {
    return join(app.getPath('userData'), 'plugin-files');
  }
  return join(homedir(), '.fynvra-dev', 'plugins');
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
      const plugins = getPluginRegistry();
      return {
        ok: true,
        plugins: await plugins.list(),
        providerMap: await plugins.getProviderMap(),
      };
    } catch (error) {
      return { ok: false, error: translate('plugins.readFailed', { error: errorMessage(error) }) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_ADD_LOCAL,
    async (event, raw: unknown): Promise<PluginAddResult> => {
      const mode = parseAddLocal(raw);
      if (!mode) {
        return { ok: false, code: 'invalid', error: translate('common.invalidArgs') };
      }
      return exclusive(busyResult, async () => {
        try {
          return await addLocal(event.sender, mode);
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

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_SET_PROVIDER_MAPPING,
    async (_event, raw: unknown): Promise<PluginSetProviderMappingResult> => {
      const input = parseProviderMapping(raw);
      if (!input) return { ok: false, error: translate('plugins.invalidProviderMapping') };
      try {
        if (input.serviceId !== null) {
          const serviceId = input.serviceId;
          const exists = (await getProviderStore().list()).some(
            (provider) => provider.id === serviceId
          );
          if (!exists) return { ok: false, error: translate('plugins.providerServiceNotFound') };
        }
        const plugins = getPluginRegistry();
        if (await plugins.setProviderMapping(input.name, input.serviceId)) {
          sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
        }
        return { ok: true, providerMap: await plugins.getProviderMap() };
      } catch (error) {
        return {
          ok: false,
          error: translate('plugins.updateFailed', { error: errorMessage(error) }),
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_REVEAL,
    async (_event, rawId: unknown): Promise<IpcResult> => {
      if (!isRegistryId(rawId)) return { ok: false, error: translate('plugins.invalidId') };
      try {
        const plugin = await getPluginRegistry().get(rawId);
        if (!plugin) return { ok: false, error: translate('plugins.notFound') };
        return await revealPath(openTarget(plugin));
      } catch (error) {
        return openFailed(error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PLUGINS_OPEN_IN, async (_event, raw: unknown): Promise<IpcResult> => {
    const input = asRecord(raw);
    if (
      !input ||
      !isRegistryId(input.id) ||
      typeof input.appId !== 'string' ||
      Object.keys(input).some((key) => key !== 'id' && key !== 'appId')
    ) {
      return { ok: false, error: translate('common.invalidArgs') };
    }
    try {
      const plugin = await getPluginRegistry().get(input.id);
      if (!plugin) return { ok: false, error: translate('plugins.notFound') };
      const target = openTarget(plugin);
      if (input.appId === 'explorer') return await revealPath(target);
      const application =
        input.appId === 'vscode'
          ? await detectVsCode()
          : getSettingsFile()
              .read()
              .preferences.openWithApps?.find((item) => item.id === input.appId)?.path;
      if (!application || !validCustomAppPath(application)) {
        return { ok: false, error: translate('workspaces.appUnavailable') };
      }
      await launchApplication(application, target);
      return { ok: true };
    } catch (error) {
      return openFailed(error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_OPEN_AS_WORKSPACE,
    async (_event, rawId: unknown): Promise<PluginOpenAsWorkspaceResult> => {
      if (!isRegistryId(rawId)) return { ok: false, error: translate('plugins.invalidId') };
      try {
        const plugin = await getPluginRegistry().get(rawId);
        if (!plugin) return { ok: false, error: translate('plugins.notFound') };
        const target = openTarget(plugin);
        const dir = (await stat(target)).isDirectory() ? target : dirname(target);
        const result = await getWorkspaceService().addDirectory(dir, { plain: true });
        if (!result.ok) return { ok: false, error: result.error };
        if (result.created) sendToAllWindows(IPC_CHANNELS.WORKSPACES_CHANGED);
        return { ok: true, workspaceId: result.workspace.id };
      } catch (error) {
        return openFailed(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_RECOPY,
    async (_event, rawId: unknown): Promise<PluginActionResult> => {
      if (!isRegistryId(rawId)) {
        return { ok: false, code: 'invalid', error: translate('plugins.invalidId') };
      }
      return exclusive(busyResult, async () => {
        try {
          return await recopy(rawId);
        } catch (error) {
          return { ok: false, code: 'failed', error: errorMessage(error) };
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_CONVERT_TO_COPY,
    async (_event, rawId: unknown): Promise<PluginActionResult> => {
      if (!isRegistryId(rawId)) {
        return { ok: false, code: 'invalid', error: translate('plugins.invalidId') };
      }
      return exclusive(busyResult, async () => {
        try {
          return await convertToCopy(rawId);
        } catch (error) {
          return { ok: false, code: 'failed', error: errorMessage(error) };
        }
      });
    }
  );
}

/** 不传参数视为 `{ mode: 'copy' }`（兼容旧调用）；只接受 `mode` 一个键 */
function parseAddLocal(raw: unknown): PluginMode | null {
  if (raw === undefined) return 'copy';
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'mode')) return null;
  if (record.mode === undefined) return 'copy';
  return isPluginMode(record.mode) ? record.mode : null;
}

/**
 * 「打开」类操作的目标：copy 模式为副本目录，其余（link、npm / git）为登记的路径。
 * 路径只来自注册表，Renderer 只传 id。
 */
function openTarget(plugin: PluginEntry): string {
  if (localPluginMode(plugin) === 'copy') {
    const dir = copyDirOf(pluginCopyRoot(), plugin.path);
    if (dir) return dir;
  }
  return plugin.path;
}

/** 目录直接打开，文件在文件管理器里选中 */
async function revealPath(target: string): Promise<IpcResult> {
  if ((await stat(target)).isDirectory()) {
    const error = await shell.openPath(target);
    return error ? openFailed(error) : { ok: true };
  }
  shell.showItemInFolder(target);
  return { ok: true };
}

/** 只带错误码或 shell 返回的文案，不带 fs 错误里的路径 */
function openFailed(error: unknown): { ok: false; error: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail =
    typeof error === 'string' ? error : typeof code === 'string' ? code : errorMessage(error);
  return { ok: false, error: translate('plugins.openFailed', { error: detail }) };
}

/** 来源与副本根目录互相包含时不复制（会把副本复制进自己） */
function overlapsCopyRoot(source: string): boolean {
  const root = resolve(pluginCopyRoot());
  const src = resolve(source);
  return src === root || isStrictlyInside(root, src) || isStrictlyInside(src, root);
}

/** 复制到副本根目录下的新目录 `<base>`（磁盘上已存在则用 `<base>-2` 等，绝不覆盖） */
async function makeCopy(source: string, base: string) {
  if (overlapsCopyRoot(source)) {
    return { ok: false as const, error: translate('plugins.sourceInCopyRoot') };
  }
  const root = pluginCopyRoot();
  return copyPluginInto(root, source, await freeCopyDirName(root, base));
}

/** 新登记插件将得到的 id（与 registry.add 的算法一致），用作副本目录名 */
async function expectedId(name: string): Promise<string> {
  const ids = (await getPluginRegistry().list()).map((entry) => entry.id);
  return uniqueId(toSlug(name.trim() || 'plugin', 'plugin'), ids);
}

function busyResult(): { ok: false; code: 'busy'; error: string } {
  return { ok: false, code: 'busy', error: translate('plugins.busy') };
}

/**
 * copy：校验、查重后复制到副本根目录再登记（登记失败删掉刚复制的副本），原文件不动；
 * link：只登记原路径（开发模式，修改与原文件同步）。
 */
async function addLocal(sender: Electron.WebContents, mode: PluginMode): Promise<PluginAddResult> {
  const picked = await pickLocalPlugin(sender);
  if (!picked) return { ok: false, code: 'canceled', error: translate('common.canceled') };
  const checked = await inspectLocalPlugin(picked);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const plugins = getPluginRegistry();
  if (mode === 'link') {
    const added = await plugins.add({
      name: checked.name,
      source: checked.path,
      kind: 'local',
      path: checked.path,
      mode: 'link',
    });
    if (!added.ok) return { ok: false, code: 'invalid', error: added.error };
    sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
    return { ok: true, plugin: added.plugin };
  }

  const duplicate = await plugins.findDuplicate({ source: checked.path, path: checked.path });
  if (duplicate) {
    return {
      ok: false,
      code: 'invalid',
      error: translate('plugins.alreadyRegistered', { name: duplicate.name }),
    };
  }
  const copied = await makeCopy(checked.path, await expectedId(checked.name));
  if (!copied.ok) return { ok: false, code: 'failed', error: copied.error };
  const added = await plugins.add({
    name: checked.name,
    source: checked.path,
    kind: 'local',
    path: copied.path,
    mode: 'copy',
    sourcePath: checked.path,
  });
  if (!added.ok) {
    await discardCopy(copied.path);
    return { ok: false, code: 'invalid', error: added.error };
  }
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: added.plugin };
}

/** 只删副本根目录内的目录；不在根目录内时什么也不删 */
async function discardCopy(loadPath: string): Promise<void> {
  const root = pluginCopyRoot();
  const dir = copyDirOf(root, loadPath);
  if (dir) await removeCopyDir(root, dir).catch(() => undefined);
}

/** 仅 copy 模式：从 sourcePath 重新复制，先进临时目录再替换，失败保留旧副本 */
async function recopy(id: string): Promise<PluginActionResult> {
  const plugins = getPluginRegistry();
  const plugin = await plugins.get(id);
  if (!plugin) return { ok: false, code: 'invalid', error: translate('plugins.notFound') };
  if (localPluginMode(plugin) !== 'copy' || !plugin.sourcePath) {
    return { ok: false, code: 'invalid', error: translate('plugins.notCopy') };
  }
  const root = pluginCopyRoot();
  const copyDir = copyDirOf(root, plugin.path);
  if (!copyDir) return { ok: false, code: 'invalid', error: translate('plugins.outsideCopyRoot') };
  const checked = await inspectLocalPlugin(plugin.sourcePath);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  if (overlapsCopyRoot(checked.path)) {
    return { ok: false, code: 'invalid', error: translate('plugins.sourceInCopyRoot') };
  }
  const copied = await replaceCopy(root, copyDir, checked.path);
  if (!copied.ok) return { ok: false, code: 'failed', error: copied.error };
  const updated = await plugins.updateLocal(id, {
    path: copied.path,
    mode: 'copy',
    sourcePath: plugin.sourcePath,
  });
  if (!updated) return { ok: false, code: 'failed', error: translate('plugins.notFound') };
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: updated };
}

/** 仅 link 模式：把原路径复制成副本，条目改为 copy（sourcePath = 原 path） */
async function convertToCopy(id: string): Promise<PluginActionResult> {
  const plugins = getPluginRegistry();
  const plugin = await plugins.get(id);
  if (!plugin) return { ok: false, code: 'invalid', error: translate('plugins.notFound') };
  if (localPluginMode(plugin) !== 'link') {
    return { ok: false, code: 'invalid', error: translate('plugins.notLink') };
  }
  const checked = await inspectLocalPlugin(plugin.path);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const copied = await makeCopy(checked.path, plugin.id);
  if (!copied.ok) return { ok: false, code: 'failed', error: copied.error };
  const updated = await plugins.updateLocal(id, {
    path: copied.path,
    mode: 'copy',
    sourcePath: plugin.path,
  });
  if (!updated) {
    await discardCopy(copied.path);
    return { ok: false, code: 'failed', error: translate('plugins.notFound') };
  }
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: updated };
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

/**
 * link 插件只删登记，绝不删除用户的目录或文件；copy 插件先删副本目录（仅当它 resolve 后在副本根目录内，
 * 否则不删任何文件）；npm / git 插件先经 pi 卸载，成功后再删登记。
 */
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
  } else if (localPluginMode(plugin) === 'copy') {
    const root = pluginCopyRoot();
    const dir = copyDirOf(root, plugin.path);
    if (dir) await removeCopyDir(root, dir);
  }
  await plugins.remove(id);
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true };
}

/** 只接受 `name` 与 `serviceId` 两个键；serviceId 为 null 或 registry id */
function parseProviderMapping(raw: unknown): SetPluginProviderMappingInput | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'name' && key !== 'serviceId')) {
    return null;
  }
  const { name, serviceId } = record;
  if (!isPluginProviderName(name)) return null;
  if (serviceId === null) return { name, serviceId: null };
  return isRegistryId(serviceId) ? { name, serviceId } : null;
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
