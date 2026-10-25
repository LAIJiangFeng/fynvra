import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Workspace, WorkspaceAddResult, WorkspaceSummary } from '@shared/types/workspace';
import { type DirectoryInspection, inspectDirectory, samePath } from './gitRepository';
import type { SettingsFile } from './settingsFile';

export interface WorkspaceServiceOptions {
  settings: SettingsFile;
  inspect?: (dir: string, options: { plain: boolean }) => Promise<DirectoryInspection>;
  newId?: () => string;
  home?: string;
  platform?: NodeJS.Platform;
}

/** 仓库子目录：Main 先问用户挂仓库根目录（`repoRoot`），还是把子目录按普通目录挂入。 */
export type AddDirectoryResult =
  | WorkspaceAddResult
  | { ok: false; code: 'not-repo-root'; repoRoot: string; error: string };

/** 工作区注册表：数据存在 settings.json，完整路径只留在 Main，对外视图是 WorkspaceSummary。 */
export function createWorkspaceService({
  settings,
  inspect = (dir, options) => inspectDirectory(dir, options),
  newId = randomUUID,
  home = homedir(),
  platform = process.platform,
}: WorkspaceServiceOptions) {
  const summarize = (workspace: Workspace): WorkspaceSummary => ({
    id: workspace.id,
    name: workspace.name,
    displayPath: toDisplayPath(workspace.repoPath, home, platform),
    vcs: workspace.vcs,
    ...(workspace.defaultBranch ? { defaultBranch: workspace.defaultBranch } : {}),
  });

  return {
    list(): WorkspaceSummary[] {
      return settings.read().workspaces.map(summarize);
    },

    /** Main 内部按 id 取完整记录（含 repoPath），不经 IPC 暴露。 */
    get(id: string): Workspace | undefined {
      return settings.read().workspaces.find((workspace) => workspace.id === id);
    },

    /**
     * 挂入目录：git 仓库根目录是 git 工作区，其他目录（以及 `plain` 时）是普通目录；
     * 仓库子目录返回 not-repo-root。同一目录重复挂入返回已有记录（不改它的 vcs）。
     */
    async addDirectory(dir: string, { plain = false } = {}): Promise<AddDirectoryResult> {
      const inspection = await inspect(dir, { plain });
      if (!inspection.ok) return inspection;
      const existing = settings
        .read()
        .workspaces.find((workspace) => samePath(workspace.repoPath, inspection.root, platform));
      if (existing) return { ok: true, workspace: summarize(existing), created: false };

      const workspace: Workspace = {
        id: newId(),
        name: inspection.name,
        repoPath: inspection.root,
        vcs: inspection.vcs,
        ...(inspection.vcs === 'git' ? { defaultBranch: inspection.defaultBranch } : {}),
      };
      settings.update((current) => ({
        ...current,
        workspaces: [...current.workspaces, workspace],
      }));
      return { ok: true, workspace: summarize(workspace), created: true };
    },

    /** 只从列表移除，不触碰磁盘上的仓库；id 不存在时返回 false。 */
    remove(id: string): boolean {
      return settings.update((current) => ({
        ...current,
        workspaces: current.workspaces.filter((workspace) => workspace.id !== id),
      })).changed;
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;

/** 展示用路径：非 Windows 下把 home 前缀缩写为 `~`（与 VS Code 的约定一致）。 */
export function toDisplayPath(path: string, home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32' || !home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
