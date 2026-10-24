import { asRecord } from '../guards';
import type { IpcResult } from './ipc';
import { parseWorkspace, type Workspace } from './workspace';

export const SETTINGS_VERSION = 1;

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Renderer 可读写的界面偏好，经 `settings:update` 合并落盘。 */
export interface Preferences {
  theme: ThemeMode;
  /** 右侧面板是否展开 */
  sidePanelOpen: boolean;
  /**
   * worker 会话 bash 工具用的 shell，覆盖 Main 的自动探测（Windows 上找 Git Bash）。
   * 只能手改 settings.json：`settings:update` 不接受这个字段（Renderer 不传路径）。
   */
  shellPath?: string;
}

/**
 * `userData/settings.json` 的完整结构。Main 是唯一写入者：
 * `preferences` 由 Renderer 经 `settings:update` 修改，`workspaces` 只经 `workspaces:*` 修改。
 */
export interface Settings {
  version: typeof SETTINGS_VERSION;
  preferences: Preferences;
  workspaces: Workspace[];
}

export type PreferencesResult = IpcResult<{ preferences: Preferences }>;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'system',
  sidePanelOpen: true,
});

export function createDefaultSettings(): Settings {
  return { version: SETTINGS_VERSION, preferences: { ...DEFAULT_PREFERENCES }, workspaces: [] };
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** 宽松收窄：逐字段取合法值，缺失或非法的字段用默认值。 */
export function parsePreferences(raw: unknown): Preferences {
  const record = asRecord(raw);
  const theme = record?.theme;
  const sidePanelOpen = record?.sidePanelOpen;
  const shellPath = typeof record?.shellPath === 'string' ? record.shellPath.trim() : '';
  return {
    theme: isThemeMode(theme) ? theme : DEFAULT_PREFERENCES.theme,
    sidePanelOpen:
      typeof sidePanelOpen === 'boolean' ? sidePanelOpen : DEFAULT_PREFERENCES.sidePanelOpen,
    ...(shellPath ? { shellPath } : {}),
  };
}

/**
 * 把磁盘上（或任意来源）的未知值收窄成合法 Settings：非法字段回落默认值，
 * 非法或重复 id 的工作区丢弃，未知键丢弃。永不抛异常，每次返回新对象。
 */
export function parseSettings(raw: unknown): Settings {
  const record = asRecord(raw);
  const workspaces: Workspace[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(record?.workspaces) ? record.workspaces : []) {
    const workspace = parseWorkspace(entry);
    if (!workspace || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    workspaces.push(workspace);
  }
  return {
    version: SETTINGS_VERSION,
    preferences: parsePreferences(record?.preferences),
    workspaces,
  };
}

/**
 * IPC 入参收窄（严格）：只接受已知字段且值合法的部分更新；
 * 任何未知字段或非法值都让整个 patch 作废，返回 null。
 */
export function parsePreferencesPatch(raw: unknown): Partial<Preferences> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const patch: Partial<Preferences> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    switch (key) {
      case 'theme':
        if (!isThemeMode(value)) return null;
        patch.theme = value;
        break;
      case 'sidePanelOpen':
        if (typeof value !== 'boolean') return null;
        patch.sidePanelOpen = value;
        break;
      default:
        return null;
    }
  }
  return patch;
}
