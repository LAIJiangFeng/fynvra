import { isThinkingLevel } from '@fynvra/core';
import { asRecord, isNonEmptyString } from '../guards';
import type { SessionModelRef } from './chat';
import type { IpcResult } from './ipc';
import { parseWorkspace, parseWorkspaceId, type Workspace } from './workspace';

export const SETTINGS_VERSION = 1;

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** 闲置多少天后归档；0 为关闭 */
export const ARCHIVE_IDLE_DAYS = [0, 7, 14, 30, 90] as const;
export type ArchiveIdleDays = (typeof ARCHIVE_IDLE_DAYS)[number];
/** 归档多少天后删除记录；0 为永不 */
export const DELETE_ARCHIVED_DAYS = [0, 30, 90] as const;
export type DeleteArchivedDays = (typeof DELETE_ARCHIVED_DAYS)[number];

/** Renderer 可读写的界面偏好，经 `settings:update` 合并落盘。 */
export interface Preferences {
  theme: ThemeMode;
  /** 右侧面板是否展开 */
  sidePanelOpen: boolean;
  // --- sessions ---（Main 的归档扫描按它执行；没写过时取 DEFAULT_SESSION_PREFERENCES）
  /** 超过这么多天没有更新的会话移入「已归档」 */
  archiveIdleDays?: ArchiveIdleDays;
  /** 归档时删除会话绑定的 worktree：只删已合并且干净的 */
  cleanupWorktreeOnArchive?: boolean;
  /** 归档超过这么多天的会话删除记录（pi jsonl 保留） */
  deleteArchivedDays?: DeleteArchivedDays;
  // --- timeline ---（只影响时间线显示；没写过时取 DEFAULT_TIMELINE_PREFERENCES）
  /** read / grep / find / ls 单行显示，连续的合成一条「N 次读取」 */
  compactReadonlyTools?: boolean;
  /** 运行中的文件修改工具自动展开 diff / 写入内容 */
  autoExpandEdits?: boolean;
  /** 流式思考时展开思考块，结束后收起 */
  autoExpandThinking?: boolean;
  /** 之前的轮次折叠成一行（提问 + 时间），只展开最后一轮 */
  foldHistoryTurns?: boolean;
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
  /**
   * 每个工作区上一次用过的模型（新建会话弹层的默认值之一），只存设置里的服务 id、模型 id 与思考档位。
   * Main 在新建会话、切换模型时写入，`settings:update` 不接受这个字段。
   */
  lastModelByWorkspace?: Record<string, SessionModelRef>;
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

// --- sessions ---
export type SessionPreferences = Required<
  Pick<Preferences, 'archiveIdleDays' | 'cleanupWorktreeOnArchive' | 'deleteArchivedDays'>
>;

/** 自动归档、清理与删除默认都不做：都是改动用户数据的动作，由用户打开 */
export const DEFAULT_SESSION_PREFERENCES: Readonly<SessionPreferences> = Object.freeze({
  archiveIdleDays: 0,
  cleanupWorktreeOnArchive: false,
  deleteArchivedDays: 0,
});

export function isArchiveIdleDays(value: unknown): value is ArchiveIdleDays {
  return (ARCHIVE_IDLE_DAYS as readonly unknown[]).includes(value);
}

export function isDeleteArchivedDays(value: unknown): value is DeleteArchivedDays {
  return (DELETE_ARCHIVED_DAYS as readonly unknown[]).includes(value);
}

/** 生效的会话偏好：没写过的取默认值 */
export function sessionPreferencesOf(preferences: Preferences): SessionPreferences {
  const defaults = DEFAULT_SESSION_PREFERENCES;
  return {
    archiveIdleDays: preferences.archiveIdleDays ?? defaults.archiveIdleDays,
    cleanupWorktreeOnArchive:
      preferences.cleanupWorktreeOnArchive ?? defaults.cleanupWorktreeOnArchive,
    deleteArchivedDays: preferences.deleteArchivedDays ?? defaults.deleteArchivedDays,
  };
}

function parseSessionPreferences(
  record: Record<string, unknown> | null
): Partial<SessionPreferences> {
  const { archiveIdleDays, cleanupWorktreeOnArchive, deleteArchivedDays } = record ?? {};
  return {
    ...(isArchiveIdleDays(archiveIdleDays) ? { archiveIdleDays } : {}),
    ...(typeof cleanupWorktreeOnArchive === 'boolean' ? { cleanupWorktreeOnArchive } : {}),
    ...(isDeleteArchivedDays(deleteArchivedDays) ? { deleteArchivedDays } : {}),
  };
}

// --- timeline ---
const TIMELINE_FLAGS = [
  'compactReadonlyTools',
  'autoExpandEdits',
  'autoExpandThinking',
  'foldHistoryTurns',
] as const;

export type TimelinePreferences = Required<Pick<Preferences, (typeof TIMELINE_FLAGS)[number]>>;

export const DEFAULT_TIMELINE_PREFERENCES: Readonly<TimelinePreferences> = Object.freeze({
  compactReadonlyTools: true,
  autoExpandEdits: true,
  autoExpandThinking: true,
  foldHistoryTurns: false,
});

/** 生效的时间线偏好：没写过的取默认值 */
export function timelinePreferencesOf(preferences: Preferences): TimelinePreferences {
  const resolved = { ...DEFAULT_TIMELINE_PREFERENCES };
  for (const flag of TIMELINE_FLAGS) resolved[flag] = preferences[flag] ?? resolved[flag];
  return resolved;
}

function parseTimelinePreferences(
  record: Record<string, unknown> | null
): Partial<TimelinePreferences> {
  const parsed: Partial<TimelinePreferences> = {};
  for (const flag of TIMELINE_FLAGS) {
    const value = record?.[flag];
    if (typeof value === 'boolean') parsed[flag] = value;
  }
  return parsed;
}

/** 形如绝对路径：`/…`、`\\server\share…`、`C:\…` / `C:/…`。src/shared 不能用 node:path，只看形状。 */
function looksAbsolute(path: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);
}

function parseModelRef(raw: unknown): SessionModelRef | null {
  const record = asRecord(raw);
  if (!record || !isNonEmptyString(record.providerId) || !isNonEmptyString(record.modelId)) {
    return null;
  }
  const { providerId, modelId, thinking } = record;
  if (thinking !== undefined && !isThinkingLevel(thinking)) return null;
  return { providerId, modelId, ...(thinking !== undefined ? { thinking } : {}) };
}

/** 键须是合法的工作区 id，值只取 id 引用；逐条丢弃非法项，一条不剩时返回 undefined。 */
function parseLastModels(raw: unknown): Record<string, SessionModelRef> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const entries: [string, SessionModelRef][] = [];
  for (const [workspaceId, value] of Object.entries(record)) {
    const ref = parseModelRef(value);
    if (parseWorkspaceId(workspaceId) && ref) entries.push([workspaceId, ref]);
  }
  // fromEntries 定义自有属性：键是 `__proto__` 也不会改到原型
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** 宽松收窄：逐字段取合法值，缺失或非法的字段用默认值。 */
export function parsePreferences(raw: unknown): Preferences {
  const record = asRecord(raw);
  const theme = record?.theme;
  const sidePanelOpen = record?.sidePanelOpen;
  const shellPath = typeof record?.shellPath === 'string' ? record.shellPath.trim() : '';
  const worktreesRoot =
    typeof record?.worktreesRoot === 'string' ? record.worktreesRoot.trim() : '';
  const lastModelByWorkspace = parseLastModels(record?.lastModelByWorkspace);
  return {
    theme: isThemeMode(theme) ? theme : DEFAULT_PREFERENCES.theme,
    sidePanelOpen:
      typeof sidePanelOpen === 'boolean' ? sidePanelOpen : DEFAULT_PREFERENCES.sidePanelOpen,
    ...parseSessionPreferences(record),
    ...parseTimelinePreferences(record),
    ...(shellPath ? { shellPath } : {}),
    ...(looksAbsolute(worktreesRoot) ? { worktreesRoot } : {}),
    ...(lastModelByWorkspace ? { lastModelByWorkspace } : {}),
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
      // --- sessions ---
      case 'archiveIdleDays':
        if (!isArchiveIdleDays(value)) return null;
        patch.archiveIdleDays = value;
        break;
      case 'deleteArchivedDays':
        if (!isDeleteArchivedDays(value)) return null;
        patch.deleteArchivedDays = value;
        break;
      case 'cleanupWorktreeOnArchive':
      // --- timeline ---
      case 'compactReadonlyTools':
      case 'autoExpandEdits':
      case 'autoExpandThinking':
      case 'foldHistoryTurns':
        if (typeof value !== 'boolean') return null;
        patch[key] = value;
        break;
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
