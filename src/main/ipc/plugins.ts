import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  isPluginProviderName,
  localPluginMode,
  MAX_PLUGIN_IMPORT_IDS,
  MAX_REQUESTED_PROVIDERS,
  type PluginEntry,
  parseRemotePluginSource,
  type SetPluginManualProvidersInput,
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
  PluginImportResult,
  PluginListResult,
  PluginOpenAsWorkspaceResult,
  PluginRemoveResult,
  PluginScanImportsResult,
  PluginSetManualProvidersResult,
  PluginSetProviderMappingResult,
  PluginToggleResult,
} from '../../preload/domains/plugins';
import { translate } from '../i18n';
import { detectVsCode, launchApplication, validCustomAppPath } from '../services/openWith';
import { type PiImportCandidate, scanPiPlugins } from '../services/plugins/piImport';
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
import { scanPluginProviders } from '../services/plugins/providerScan';
import { isRegistryId, toSlug, uniqueId } from '../services/providers/jsonRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';
import { showAppMessageBox } from './appDialog';
import { getProviderStore } from './providers';
import { getRoleStore } from './roles';
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
        plugins: await refreshScans(plugins),
        providerMap: await plugins.getProviderMap(),
      };
    } catch (error) {
      return { ok: false, error: translate('plugins.readFailed', { error: errorMessage(error) }) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_ADD_LOCAL,
    async (event, raw: unknown): Promise<PluginAddResult> => {
      if (!isEmptyArgs(raw)) {
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
    IPC_CHANNELS.PLUGINS_SCAN_IMPORTS,
    async (_event, raw: unknown): Promise<PluginScanImportsResult> => {
      if (!isEmptyArgs(raw)) return { ok: false, error: translate('common.invalidArgs') };
      try {
        const scan = await scanPiPlugins({
          home: homedir(),
          env: process.env,
          existing: await getPluginRegistry().list(),
        });
        importCache = new Map(scan.candidates.map((candidate) => [candidate.id, candidate]));
        return {
          ok: true,
          candidates: scan.candidates.map(toCandidateView),
          warnings: scan.warnings,
        };
      } catch (error) {
        return {
          ok: false,
          error: translate('plugins.importScanFailed', { error: scanWarning(error) }),
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PLUGINS_IMPORT,
    async (_event, raw: unknown): Promise<PluginImportResult> => {
      const ids = parseImportIds(raw);
      if (!ids) return { ok: false, error: translate('common.invalidArgs') };
      return exclusive(
        () => ({ ok: false, error: translate('plugins.busy') }),
        () => importCandidates(ids)
      );
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
    IPC_CHANNELS.PLUGINS_SET_MANUAL_PROVIDERS,
    async (_event, raw: unknown): Promise<PluginSetManualProvidersResult> => {
      const input = parseManualProviders(raw);
      if (!input) return { ok: false, error: translate('plugins.invalidManualProviders') };
      try {
        const result = await getPluginRegistry().setManualProviders(input.id, input.names);
        if (!result) return { ok: false, error: translate('plugins.notFound') };
        if (result.changed) sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
        return { ok: true, plugin: result.plugin };
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

/** 日志只带错误码，不带 fs 错误里的路径 */
function scanWarning(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * 添加 / 安装 / 复制成功后立即扫描并写入；失败只记 warning，返回原条目，不影响操作本身
 */
async function scanAfterChange(plugin: PluginEntry): Promise<PluginEntry> {
  try {
    const scan = await scanPluginProviders(plugin.path);
    const updated = await getPluginRegistry().updateScan(plugin.id, plugin.path, {
      providers: scan.names ?? [],
      stamp: scan.stamp,
    });
    return updated ?? plugin;
  } catch (error) {
    console.warn(`[plugins] scan failed for ${plugin.id}: ${scanWarning(error)}`);
    return plugin;
  }
}

/**
 * plugins:list 时补扫：没有扫描记录或 stamp 变了就重新扫描并写入（写入走注册表串行队列）。
 * 不广播 plugins:changed（Renderer 收到广播会再调 list，会循环）。
 */
async function refreshScans(plugins: PluginRegistry): Promise<PluginEntry[]> {
  const entries = await plugins.list();
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const scan = await scanPluginProviders(entry.path, entry.scanStamp);
        if (scan.names === null) return false;
        await plugins.updateScan(entry.id, entry.path, {
          providers: scan.names,
          stamp: scan.stamp,
        });
        return true;
      } catch (error) {
        // 路径不存在（如引用的原文件被删）很常见，不刷日志
        if (scanWarning(error) !== 'ENOENT') {
          console.warn(`[plugins] scan failed for ${entry.id}: ${scanWarning(error)}`);
        }
        return false;
      }
    })
  );
  return results.some(Boolean) ? plugins.list() : entries;
}

/** 只接受 `id` 与 `names` 两个键；names 全部合法、最多 20 个，去重后保序 */
function parseManualProviders(raw: unknown): SetPluginManualProvidersInput | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id' && key !== 'names')) return null;
  const { id, names } = record;
  if (!isRegistryId(id) || !Array.isArray(names) || names.length > MAX_REQUESTED_PROVIDERS) {
    return null;
  }
  if (!names.every((name) => isPluginProviderName(name))) return null;
  return { id, names: [...new Set(names as string[])] };
}

/** 上一次 plugins:scan-imports 的候选（含路径 / 来源），按 id 查找；每次扫描整体替换 */
let importCache = new Map<string, PiImportCandidate>();

function toCandidateView(candidate: PiImportCandidate) {
  const { id, name, kind, form, display, duplicateOf } = candidate;
  return {
    id,
    name,
    kind,
    display,
    ...(form ? { form } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
  };
}

/** 只接受 `{ ids }`：1–200 个非空字符串（最长 64），去重保序 */
function parseImportIds(raw: unknown): string[] | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'ids')) return null;
  const { ids } = record;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PLUGIN_IMPORT_IDS) return null;
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) return null;
  return [...new Set(ids as string[])];
}

/**
 * 在 exclusive 锁内逐个导入：本地候选走与「添加本地插件」相同的复制流程，npm / git 走 installRemote。
 * 某项失败不影响其他项；全部结束后有成功的才广播一次 plugins:changed。错误里不带完整路径。
 */
async function importCandidates(ids: readonly string[]): Promise<PluginImportResult> {
  const imported: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const id of ids) {
    const candidate = importCache.get(id);
    if (!candidate) {
      failed.push({ name: id, error: translate('plugins.importUnknown') });
      continue;
    }
    if (candidate.duplicateOf) {
      failed.push({
        name: candidate.name,
        error: translate('plugins.alreadyRegistered', { name: candidate.duplicateOf }),
      });
      continue;
    }
    let result: PluginAddResult;
    try {
      if (candidate.kind === 'local') {
        const missing = await lstat(candidate.path).then(
          () => null,
          (error: unknown) => scanWarning(error)
        );
        result = missing
          ? {
              ok: false,
              code: 'invalid',
              error: translate('plugins.pathMissing', { error: missing }),
            }
          : await registerLocal(candidate.path);
      } else {
        result = await registerRemote(candidate.source, candidate.kind);
      }
    } catch (error) {
      result = { ok: false, code: 'failed', error: scanWarning(error) };
    }
    if (result.ok) {
      imported.push(result.plugin.name);
      importCache.set(id, { ...candidate, duplicateOf: result.plugin.name });
    } else {
      failed.push({ name: candidate.name, error: result.error });
    }
  }
  if (imported.length > 0) sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, imported, failed };
}

/** plugins:add-local 不带参数：只接受 undefined 或空对象 `{}` */
function isEmptyArgs(raw: unknown): boolean {
  if (raw === undefined) return true;
  const record = asRecord(raw);
  return record !== null && Object.keys(record).length === 0;
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
 * 本地插件一律复制：校验、查重后复制到副本根目录再登记（登记失败删掉刚复制的副本），原文件不动。
 * 旧版登记的 link 条目仍可用，可经 convertToCopy 转为副本。
 */
async function addLocal(sender: Electron.WebContents): Promise<PluginAddResult> {
  const picked = await pickLocalPlugin(sender);
  if (!picked) return { ok: false, code: 'canceled', error: translate('common.canceled') };
  const result = await registerLocal(picked);
  if (result.ok) sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return result;
}

/** 按路径添加本地插件（校验、查重、复制、登记、扫描服务名）；不广播，由调用方决定 */
async function registerLocal(picked: string): Promise<PluginAddResult> {
  const checked = await inspectLocalPlugin(picked);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const plugins = getPluginRegistry();
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
  return { ok: true, plugin: await scanAfterChange(added.plugin) };
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
  const scanned = await scanAfterChange(updated);
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: scanned };
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
  const scanned = await scanAfterChange(updated);
  sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return { ok: true, plugin: scanned };
}

async function installRemote(source: string, kind: 'npm' | 'git'): Promise<PluginAddResult> {
  const result = await registerRemote(source, kind);
  if (result.ok) sendToAllWindows(IPC_CHANNELS.PLUGINS_CHANGED);
  return result;
}

/** 经 pi 包管理器安装并登记、扫描服务名；不广播，由调用方决定 */
async function registerRemote(source: string, kind: 'npm' | 'git'): Promise<PluginAddResult> {
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
  return { ok: true, plugin: await scanAfterChange(added.plugin) };
}

/**
 * link 插件只删登记，绝不删除用户的目录或文件；copy 插件先删副本目录（仅当它 resolve 后在副本根目录内，
 * 否则不删任何文件）；npm / git 插件先经 pi 卸载，成功后再删登记。删除成功后从所有角色的 pluginIds 中移除。
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
  await unbindFromRoles(id);
  return { ok: true };
}

/**
 * 把已删除的插件从所有角色的 pluginIds 中去掉；有角色改动就广播一次 roles:changed。
 * 单个角色失败只记 warning（不带路径），不影响删除结果：会话启动时本就会跳过不存在的插件。
 */
async function unbindFromRoles(id: string): Promise<void> {
  let changed = false;
  try {
    const roles = getRoleStore();
    for (const role of await roles.list()) {
      if (!role.pluginIds?.includes(id)) continue;
      try {
        const result = await roles.save({
          ...role,
          pluginIds: role.pluginIds.filter((pluginId) => pluginId !== id),
        });
        if (result.ok) changed = true;
        else console.warn(`[plugins] failed to unbind ${id} from role ${role.id}`);
      } catch {
        console.warn(`[plugins] failed to unbind ${id} from role ${role.id}`);
      }
    }
  } catch {
    console.warn(`[plugins] failed to list roles while unbinding ${id}`);
  }
  if (changed) sendToAllWindows(IPC_CHANNELS.ROLES_CHANGED);
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
