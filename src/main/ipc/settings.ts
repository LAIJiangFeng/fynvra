import { dirname, join } from 'node:path';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  type AvailableShellsResult,
  type PickShellResult,
  type PickWorktreesRootResult,
  type PreferencesResult,
  parsePickWorktreesRootInput,
  parsePreferencesPatch,
  parseWorktreesRootInfoInput,
  type ThemeMode,
  type WorktreesRootInfoResult,
} from '@shared/types/settings';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions } from 'electron';
import { translate } from '../i18n';
import { allowedOpenWithAppsUpdate } from '../services/openWith';
import {
  collectWorktreesRootInfo,
  fallbackWorktreesRoot,
  validateWorktreesRoot,
} from '../services/orchestration/worktreesRoot';
import { createSettingsFile, type SettingsFile } from '../services/settingsFile';
import { describeShells, shellDetectionDeps, validShellPreference } from '../services/shells';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getOrchestrationRegistry } from './orchestration';

let settingsFile: SettingsFile | null = null;
/** 正在进行的 worktree 占用统计；新的统计请求会取消它。 */
let usageScan: AbortController | null = null;

/** Main 唯一的 settings.json 句柄；userData 路径在启动早期才确定，所以延迟创建。 */
export function getSettingsFile(): SettingsFile {
  settingsFile ??= createSettingsFile({ filePath: join(app.getPath('userData'), 'settings.json') });
  return settingsFile;
}

/** 原生主题跟随设置：窗口首帧背景、系统对话框与 prefers-color-scheme 一并切换。 */
function applyNativeTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
}

/** 写入（或清除）preferences.worktreesRoot，有变化时广播；只影响之后新建的 worktree。 */
function saveWorktreesRoot(worktreesRoot: string | undefined): PickWorktreesRootResult {
  const { settings, changed } = getSettingsFile().update((current) => {
    const { worktreesRoot: _previous, ...rest } = current.preferences;
    return {
      ...current,
      preferences: worktreesRoot === undefined ? rest : { ...rest, worktreesRoot },
    };
  });
  if (changed) sendToAllWindows(IPC_CHANNELS.SETTINGS_CHANGED);
  return { ok: true, preferences: settings.preferences };
}

export function registerSettingsHandlers(): void {
  applyNativeTheme(getSettingsFile().read().preferences.theme);

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (): PreferencesResult => {
    try {
      return { ok: true, preferences: getSettingsFile().read().preferences };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_AVAILABLE_SHELLS,
    async (): Promise<AvailableShellsResult> => {
      try {
        return { ok: true, ...(await describeShells(getSettingsFile().read().preferences)) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_PICK_SHELL,
    async (event, target: unknown): Promise<PickShellResult> => {
      if (target !== 'agentShell' && target !== 'terminalShell') {
        return { ok: false, error: translate('common.invalidArgs') };
      }
      try {
        const options: OpenDialogOptions = { properties: ['openFile'] };
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        const path = result.filePaths[0];
        if (result.canceled || !path)
          return { ok: false, code: 'canceled', error: translate('common.canceled') };
        const preference = { kind: 'custom' as const, path };
        const deps = shellDetectionDeps();
        if (
          !validShellPreference(preference, target === 'agentShell', deps) ||
          !deps.existsSync(path)
        ) {
          return { ok: false, error: translate('settings.invalidPatch') };
        }
        const { settings, changed } = getSettingsFile().update((current) => ({
          ...current,
          preferences: { ...current.preferences, [target]: preference },
        }));
        if (changed) sendToAllWindows(IPC_CHANNELS.SETTINGS_CHANGED);
        return { ok: true, preferences: settings.preferences };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, (event, raw: unknown): PreferencesResult => {
    const patch = parsePreferencesPatch(raw);
    const deps = shellDetectionDeps();
    if (
      !patch ||
      !validShellPreference(patch.agentShell, true, deps) ||
      !validShellPreference(patch.terminalShell, false, deps)
    ) {
      return { ok: false, error: translate('settings.invalidPatch') };
    }
    try {
      if (
        patch.openWithApps &&
        !allowedOpenWithAppsUpdate(
          patch.openWithApps,
          getSettingsFile().read().preferences.openWithApps ?? [],
          event.sender.id
        )
      )
        return { ok: false, error: translate('settings.invalidPatch') };
      const { settings, changed } = getSettingsFile().update((current) => ({
        ...current,
        preferences: { ...current.preferences, ...patch },
      }));
      if (changed) {
        applyNativeTheme(settings.preferences.theme);
        sendToAllWindows(IPC_CHANNELS.SETTINGS_CHANGED);
      }
      return { ok: true, preferences: settings.preferences };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // 不接收 Renderer 传来的路径：目录由 Main 弹窗选择，校验通过后才写入
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT,
    async (event, raw: unknown): Promise<PickWorktreesRootResult> => {
      const input = parsePickWorktreesRootInput(raw);
      if (!input) return { ok: false, code: 'invalid', error: translate('common.invalidArgs') };
      try {
        if (input.reset) return saveWorktreesRoot(undefined);
        const before = getSettingsFile().read();
        const firstRepo = before.workspaces[0]?.repoPath;
        const dir = await pickDirectory(
          event.sender,
          before.preferences.worktreesRoot ?? (firstRepo && dirname(firstRepo))
        );
        if (!dir) return { ok: false, code: 'canceled', error: translate('common.canceled') };
        // 弹框期间工作区可能有增减：按关闭时的列表校验
        const repoPaths = getSettingsFile()
          .read()
          .workspaces.map((workspace) => workspace.repoPath);
        const checked = await validateWorktreesRoot(dir, { repoPaths });
        if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
        return saveWorktreesRoot(checked.path);
      } catch (error) {
        return { ok: false, code: 'failed', error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO,
    async (_event, raw: unknown): Promise<WorktreesRootInfoResult> => {
      const input = parseWorktreesRootInfoInput(raw);
      if (!input) return { ok: false, error: translate('common.invalidArgs') };
      // 只跑最新的一次占用统计：目录大得统计要好几秒，旧的结果已经没人要了
      const scan = input.usage ? new AbortController() : undefined;
      if (scan) {
        usageScan?.abort();
        usageScan = scan;
      }
      try {
        const { preferences, workspaces } = getSettingsFile().read();
        const info = await collectWorktreesRootInfo({
          configured: preferences.worktreesRoot,
          fallbackRoot: fallbackWorktreesRoot(app.getPath('userData')),
          workspaces,
          worktreesOf: async (workspaceId) => {
            const service = getOrchestrationRegistry().serviceFor(workspaceId);
            return service === undefined ? [] : (await service.snapshot()).worktrees;
          },
          usage: input.usage,
          signal: scan?.signal,
        });
        return { ok: true, info };
      } catch (error) {
        return {
          ok: false,
          error: scan?.signal.aborted ? translate('settings.usageCanceled') : errorMessage(error),
        };
      } finally {
        if (scan !== undefined && usageScan === scan) usageScan = null;
      }
    }
  );

  app.on('before-quit', () => {
    getSettingsFile().flush();
  });
}

async function pickDirectory(
  sender: Electron.WebContents,
  defaultPath: string | undefined
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: translate('settings.pickWorktreesRoot'),
    buttonLabel: translate('common.choose'),
    properties: ['openDirectory', 'createDirectory'],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
