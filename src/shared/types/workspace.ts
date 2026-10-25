import { asRecord, isNonEmptyString } from '../guards';
import type { IpcResult } from './ipc';

/**
 * `git`：仓库根目录，编排用 worktree；`none`：普通目录（不是 git 仓库，或按普通目录挂入的仓库子目录），
 * worker 直接在目录里改。
 */
export type WorkspaceVcs = 'git' | 'none';

/**
 * 挂入的本地目录（docs/ARCHITECTURE.md §4，字段与 `@fynvra/core` 的 Workspace 保持一致）。
 * 完整路径只存在于 Main；Renderer 拿到的是 {@link WorkspaceSummary}。
 */
export interface Workspace {
  id: string;
  name: string;
  repoPath: string;
  vcs: WorkspaceVcs;
  /** 普通目录没有 */
  defaultBranch?: string;
}

/** 给 Renderer 的工作区视图：后续操作只回传 id，不含可回传的仓库路径。 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  /** 仅供展示（非 Windows 下 home 目录缩写为 `~`），不得作为参数回传 Main */
  displayPath: string;
  vcs: WorkspaceVcs;
  defaultBranch?: string;
}

export type WorkspaceAddErrorCode =
  | 'canceled'
  | 'not-git-repo'
  | 'not-repo-root'
  | 'git-unavailable'
  | 'failed';

export type WorkspaceAddResult =
  | { ok: true; workspace: WorkspaceSummary; created: boolean }
  | { ok: false; code: WorkspaceAddErrorCode; error: string };

export type WorkspaceListResult = IpcResult<{ workspaces: WorkspaceSummary[] }>;

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** IPC 入参收窄：工作区 id 是 Main 生成的不透明 token，其余形状（尤其路径）一律拒绝。 */
export function parseWorkspaceId(raw: unknown): string | null {
  return typeof raw === 'string' && WORKSPACE_ID_PATTERN.test(raw) ? raw : null;
}

export function isWorkspaceVcs(value: unknown): value is WorkspaceVcs {
  return value === 'git' || value === 'none';
}

/**
 * 磁盘数据收窄：缺字段、类型不符或 id 非法时返回 null，多余字段丢弃。
 * 没有 `vcs` 的是加这个字段之前的记录，当时只能挂入 git 仓库根目录。
 */
export function parseWorkspace(raw: unknown): Workspace | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = parseWorkspaceId(record.id);
  const { name, repoPath, vcs = 'git', defaultBranch } = record;
  if (!id || !isNonEmptyString(name) || !isNonEmptyString(repoPath)) return null;
  if (!isWorkspaceVcs(vcs)) return null;
  if (defaultBranch !== undefined && !isNonEmptyString(defaultBranch)) return null;
  return { id, name, repoPath, vcs, ...(defaultBranch !== undefined ? { defaultBranch } : {}) };
}
