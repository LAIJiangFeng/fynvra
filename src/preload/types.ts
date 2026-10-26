import type { IpcResult, WindowCloseAction } from '@shared/types/ipc';
import type {
  PickWorktreesRootResult,
  Preferences,
  PreferencesResult,
  WorktreesRootInfoResult,
} from '@shared/types/settings';
import type { WorkspaceAddResult, WorkspaceListResult } from '@shared/types/workspace';
import type { OrchestrationApi } from './domains/orchestration';

/**
 * preload 暴露给 Renderer 的 API 形状。本文件只有类型、不 import electron，
 * 这样 Renderer 的 tsconfig 只引入它，Node / Electron 类型不会混进 Renderer。
 */

export type Unsubscribe = () => void;

export interface SettingsApi {
  /** 读取界面偏好 */
  get(): Promise<PreferencesResult>;
  /** 合并更新界面偏好；Main 逐字段校验后防抖写入 settings.json */
  update(patch: Partial<Preferences>): Promise<PreferencesResult>;
  /** 无参：Main 弹目录选择框、校验后写入 worktree 根目录；`{ reset: true }`：恢复默认。不传路径 */
  pickWorktreesRoot(input?: { reset: true }): Promise<PickWorktreesRootResult>;
  /** 生效的 worktree 根目录与各工作区占用；`{ usage: false }` 只取路径，不统计目录大小 */
  worktreesRootInfo(input?: { usage: boolean }): Promise<WorktreesRootInfoResult>;
  /** 偏好被（任一窗口）修改后触发 */
  onChanged(callback: () => void): Unsubscribe;
}

export interface WorkspacesApi {
  list(): Promise<WorkspaceListResult>;
  /** Main 弹出目录选择框并校验是 git 仓库根目录；Renderer 不传路径 */
  add(): Promise<WorkspaceAddResult>;
  /** 只从列表移除，不会删除磁盘上的仓库 */
  remove(id: string): Promise<IpcResult>;
  onChanged(callback: () => void): Unsubscribe;
}

export interface WindowApi {
  /** `process.platform`，决定标题栏布局（macOS 红绿灯 / 自绘窗口按钮） */
  readonly platform: string;
  minimize(): Promise<IpcResult>;
  toggleMaximize(): Promise<IpcResult>;
  close(): Promise<IpcResult>;
  respondClose(action: WindowCloseAction): Promise<IpcResult>;
  onCloseRequested(callback: () => void): Unsubscribe;
  isMaximized(): Promise<IpcResult<{ maximized: boolean }>>;
  onMaximizedChange(callback: (maximized: boolean) => void): Unsubscribe;
}

/** 按领域分组的全部能力；刻意不提供通用 invoke / send。 */
export interface FynvraApi {
  updates: import('./domains/updates').UpdatesApi;
  settings: SettingsApi;
  workspaces: WorkspacesApi;
  files: import('./domains/files').FilesApi;
  terminals: import('./domains/terminals').TerminalsApi;
  orchestration: OrchestrationApi;
  window: WindowApi;
  sessions: import('./domains/sessions').SessionsApi;
  providers: import('./domains/providers').ProvidersApi;
  roles: import('./domains/roles').RolesApi;
  skills: import('./domains/skills').SkillsApi;
  mcp: import('./domains/mcp').McpApi;
  notifications: import('./domains/notifications').NotificationsApi;
  usage: import('./domains/usage').UsageApi;
}

declare global {
  interface Window {
    readonly fynvra: FynvraApi;
  }
}
