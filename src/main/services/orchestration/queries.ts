import type { HostResult, ReadWorkerOutputOutput, ReviewDiffOutput } from '@fynvra/agent-runtime';
import {
  type Dispatch,
  type ExecFn,
  type GitWorktreeManager,
  isDispatchSettled,
  type OrchestrationStore,
  type Worktree,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { fail } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';

// orchestration 工具（OrchestrationHost）与 orchestration IPC（面板）共用的只读查询

/** `repoPath` 当前检出的分支；detached HEAD 或 git 出错时为 `undefined`。 */
export async function currentBranch(exec: ExecFn, repoPath: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath);
    const branch = result.stdout.trim();
    return result.code === 0 && branch !== '' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** worker 已提交的改动（`baseCommit...HEAD`）：文件列表、`--stat` 摘要与完整 diff。 */
export async function reviewWorktreeDiff(
  deps: { git: GitWorktreeManager; exec: ExecFn },
  worktree: Worktree
): Promise<HostResult<ReviewDiffOutput>> {
  const diff = await deps.git.diff(worktree);
  if (!diff.ok) return fail(`could not read the diff: ${diff.error}`);
  let stat = '';
  try {
    const args = ['-c', 'core.quotepath=false', 'diff', '--stat=200', '--no-color'];
    const result = await deps.exec(
      'git',
      [...args, `${worktree.baseCommit}...HEAD`],
      worktree.path
    );
    if (result.code === 0) stat = result.stdout.trimEnd();
  } catch {
    // stat 只是摘要；diff 已经拿到，取不到 stat 时留空
  }
  return {
    ok: true,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
    files: diff.files,
    stat,
    diff: diff.patch,
  };
}

/**
 * dispatch 对应 worker 会话的输出（`launcher.readTranscript`，cursor 是字符偏移）。
 * `done` 要求会话不再产出且这次尝试已结算：进行中的尝试即使会话暂时空闲也不算完。
 */
export async function readDispatchOutput(
  deps: { store: OrchestrationStore; launcher: WorkerSessionLauncher },
  dispatch: Dispatch,
  cursor: number
): Promise<HostResult<ReadWorkerOutputOutput>> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return fail('cursor must be a non-negative integer');
  }
  let result: Awaited<ReturnType<WorkerSessionLauncher['readTranscript']>>;
  try {
    result = await deps.launcher.readTranscript(dispatch.workerSessionId, cursor);
  } catch (error) {
    result = fail(errorMessage(error));
  }
  if (!result.ok) return fail(`could not read the worker output: ${result.error}`);
  const current = deps.store.dispatches.get(dispatch.id) ?? dispatch;
  return {
    ok: true,
    text: result.text,
    total: result.total,
    done: result.done && isDispatchSettled(current),
  };
}
