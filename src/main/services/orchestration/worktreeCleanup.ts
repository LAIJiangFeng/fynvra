import type {
  Dispatch,
  GitWorktreeManager,
  OrchestrationStore,
  TaskStatus,
  WorktreeStatus,
} from '@fynvra/core';
import type { WorkerSessionLauncher } from './launcher';

/** 不能删的原因：没经 merge_worktree 合并、有未提交改动或未跟踪文件、合并之后又有新提交 */
export type MergedCleanupBlocker = 'not-merged' | 'dirty' | 'unmerged-commits';

export type MergedCleanupResult =
  | { removed: true }
  | { removed: false; reason: 'no-worktree' | MergedCleanupBlocker }
  | { removed: false; reason: 'failed'; error: string };

/**
 * 归档时能不能删 worker 的 worktree：任务经 merge_worktree 合并过（completed），git 也确认干净、
 * 没有合并之后的新提交（相对基准分支当前位置 ahead 为 0）。能删返回 null。
 */
export function mergedCleanupBlocker(
  taskStatus: TaskStatus | undefined,
  status: WorktreeStatus
): MergedCleanupBlocker | null {
  if (taskStatus !== 'completed') return 'not-merged';
  if (status.dirty) return 'dirty';
  return status.ahead > 0 ? 'unmerged-commits' : null;
}

export interface MergedCleanupDeps {
  store: OrchestrationStore;
  git: GitWorktreeManager;
  launcher: WorkerSessionLauncher;
  repoPath: string;
}

/**
 * 删掉 dispatch 的 worktree 与分支，前提是已合并且干净（{@link mergedCleanupBlocker}）；否则原样保留。
 * 与 cleanup_worktree 对已合并任务的处理相同，但更保守：不加 --force，检查之后又有了改动时 git 会拒绝。
 */
export async function cleanupMergedWorktree(
  deps: MergedCleanupDeps,
  dispatch: Dispatch | undefined
): Promise<MergedCleanupResult> {
  const worktree = dispatch && deps.store.worktrees.get(dispatch.worktreeId);
  if (dispatch === undefined || worktree === undefined) {
    return { removed: false, reason: 'no-worktree' };
  }
  const status = await deps.git.status(worktree);
  if (!status.ok) return { removed: false, reason: 'failed', error: status.error };
  const task = deps.store.tasks.get(dispatch.taskId);
  const blocker = mergedCleanupBlocker(task?.status, status.status);
  if (blocker !== null) return { removed: false, reason: blocker };

  // 先停 worker：它的进程可能还占着 worktree 里的文件
  await deps.launcher.disposeSession(dispatch.workerSessionId).catch(() => undefined);
  const removed = await deps.git.remove({ repoPath: deps.repoPath, path: worktree.path });
  if (!removed.ok) return { removed: false, reason: 'failed', error: removed.error };
  deps.store.worktrees.delete(worktree.id);
  // -d：git 再确认一次分支已合并进当前检出的分支，确认不了就留着分支
  await deps.git.deleteBranch({ repoPath: deps.repoPath, branch: worktree.branch });
  return { removed: true };
}
