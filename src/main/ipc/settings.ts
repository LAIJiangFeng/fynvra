import { join } from 'node:path';
import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  type PreferencesResult,
  parsePreferencesPatch,
  type ThemeMode,
} from '@shared/types/settings';
import { app, ipcMain, nativeTheme } from 'electron';
import { createSettingsFile, type SettingsFile } from '../services/settingsFile';
import { sendToAllWindows } from '../windows/createAppWindow';

let settingsFile: SettingsFile | null = null;

/** Main 唯一的 settings.json 句柄；userData 路径在启动早期才确定，所以延迟创建。 */
export function getSettingsFile(): SettingsFile {
  settingsFile ??= createSettingsFile({ filePath: join(app.getPath('userData'), 'settings.json') });
  return settingsFile;
}

/** 原生主题跟随设置：窗口首帧背景、系统对话框与 prefers-color-scheme 一并切换。 */
function applyNativeTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, (_event, raw: unknown): PreferencesResult => {
    const patch = parsePreferencesPatch(raw);
    if (!patch) return { ok: false, error: '无效的设置项' };
    try {
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

  app.on('before-quit', () => {
    getSettingsFile().flush();
  });
}
