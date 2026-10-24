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
  /**
   * worktree 根目录（绝对路径）：新建的 worktree 放在 `<worktreesRoot>/<仓库目录名>/<workspaceId>/<slug>`。
   * 未设置时放在仓库同级的 `<仓库目录名>-worktrees` 下。只经 `settings:pick-worktrees-root` 修改
   * （Main 弹目录框并校验），`settings:update` 不接受这个字段。
   */
  worktreesRoot?: string;
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

/** 一个工作区登记的 worktree 占用的磁盘空间。 */
export interface WorktreesUsage {
  /** 字节数；硬链接（如 pnpm 的 node_modules）只计一次 */
  bytes: number;
  /** 目录已不存在或读不了的 worktree 数 */
  missing: number;
}

/** 一个工作区的 worktree 去向与占用。路径仅供展示，不得回传 Main。 */
export interface WorkspaceWorktreesInfo {
  workspaceId: string;
  name: string;
  /** 新建 worktree 的根目录，其下按 `<workspaceId>/<slug>` 分子目录 */
  root: string;
  /** 默认位置用不了、退回 userData 的原因 */
  fallback?: string;
  /** 编排快照里登记的 worktree 数 */
  count: number;
  /** 请求了占用统计时才有 */
  usage?: WorktreesUsage;
}

/** `settings:worktrees-root-info` 的结果。 */
export interface WorktreesRootInfo {
  /** 没有配置 `preferences.worktreesRoot`：worktree 建在仓库同级目录 */
  isDefault: boolean;
  worktreesRoot?: string;
  /** 默认位置不可写时退回的目录（`userData/worktrees`） */
  fallbackRoot: string;
  workspaces: WorkspaceWorktreesInfo[];
}

export type WorktreesRootInfoResult = IpcResult<{ info: WorktreesRootInfo }>;
export type PickWorktreesRootResult =
  | { ok: true; preferences: Preferences }
  | { ok: false; code: 'canceled' | 'invalid' | 'failed'; error: string };

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

/** 形如绝对路径：`/…`、`\\server\share…`、`C:\…` / `C:/…`。src/shared 不能用 node:path，只看形状。 */
function looksAbsolute(path: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);
}

/** 宽松收窄：逐字段取合法值，缺失或非法的字段用默认值。 */
export function parsePreferences(raw: unknown): Preferences {
  const record = asRecord(raw);
  const theme = record?.theme;
  const sidePanelOpen = record?.sidePanelOpen;
  const shellPath = typeof record?.shellPath === 'string' ? record.shellPath.trim() : '';
  const worktreesRoot =
    typeof record?.worktreesRoot === 'string' ? record.worktreesRoot.trim() : '';
  return {
    theme: isThemeMode(theme) ? theme : DEFAULT_PREFERENCES.theme,
    sidePanelOpen:
      typeof sidePanelOpen === 'boolean' ? sidePanelOpen : DEFAULT_PREFERENCES.sidePanelOpen,
    ...(shellPath ? { shellPath } : {}),
    ...(looksAbsolute(worktreesRoot) ? { worktreesRoot } : {}),
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

/** 严格收窄可选的布尔开关参数：`undefined` 取默认值；只认 `{ [key]: boolean }`，其余一律 null。 */
function parseFlagInput(raw: unknown, key: string, fallback: boolean): boolean | null {
  if (raw === undefined) return fallback;
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((name) => name !== key)) return null;
  const value = record[key];
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : null;
}

/**
 * `settings:pick-worktrees-root` 入参：无参时 Main 弹目录选择框；`{ reset: true }` 恢复默认位置。
 * 不接收路径。
 */
export function parsePickWorktreesRootInput(raw: unknown): { reset: boolean } | null {
  const reset = parseFlagInput(raw, 'reset', false);
  return reset === null ? null : { reset };
}

/** `settings:worktrees-root-info` 入参：默认统计占用；`{ usage: false }` 只取路径（快）。 */
export function parseWorktreesRootInfoInput(raw: unknown): { usage: boolean } | null {
  const usage = parseFlagInput(raw, 'usage', true);
  return usage === null ? null : { usage };
}
