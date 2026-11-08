import type { HostResult } from '@fynvra/agent-runtime';
import type { Dispatch, OrchestrationStore, Task, Workspace, Worktree } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { fail } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';

/** 一次启动成功、尚未落库的尝试；`worktree` 只在本次新建时给出（落库时一并插入），普通目录没有。 */
export type Launched = { worktree: Worktree | undefined; dispatch: Dispatch };

/**
 * 为 task 起 worker 会话（第一条 prompt 是任务书），成功时给出对应的 Dispatch（未落库）。不写 store。
 * `worktree` 是这次尝试所在的 worktree（新建的或沿用的）；undefined 表示普通目录原地进行，cwd 为工作区目录。
 */
export async function startAttemptSession(
  deps: { workspace: Workspace; launcher: WorkerSessionLauncher; now: () => number },
  task: Task,
  input: { dispatchId: string; worktree: Worktree | undefined; brief: string; nodeId?: string }
): Promise<HostResult<{ dispatch: Dispatch }>> {
  const { worktree, dispatchId } = input;
  let started: Awaited<ReturnType<WorkerSessionLauncher['createWorkerSession']>>;
  try {
    started = await deps.launcher.createWorkerSession({
      workspaceId: deps.workspace.id,
      runId: task.runId,
      dispatchId,
      roleId: task.roleId,
      cwd: worktree?.path ?? deps.workspace.repoPath,
      ...(worktree ? { worktreeId: worktree.id } : {}),
      // 派发时指定的模型 / 档位 / Fast 请求记在 Task 上，排队或恢复后启动也保留 false
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.thinking !== undefined ? { thinking: task.thinking } : {}),
      ...(task.fastMode !== undefined ? { fastMode: task.fastMode } : {}),
      brief: input.brief,
    });
  } catch (error) {
    started = fail(errorMessage(error));
  }
  if (!started.ok) return started;
  const dispatch: Dispatch = {
    id: dispatchId,
    taskId: task.id,
    workerSessionId: started.sessionId,
    worktreeId: worktree?.id ?? '',
    branch: worktree?.branch ?? '',
    ...(worktree ? {} : { mode: 'in-place' as const }),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    startedAt: deps.now(),
  };
  return { ok: true, dispatch };
}

/**
 * 落库一次启动成功的尝试（同步，调用方必须紧跟在 launcher resolve 之后调用、中间不能有 await）；
 * 失败时撤掉已写入的行，task 保持原状。`patch` 随状态一起写进 task（工作流步骤的角色与进度）。
 */
export function recordAttempt(
  store: OrchestrationStore,
  task: Task,
  launched: Launched,
  isNew: boolean,
  patch: Partial<Pick<Task, 'roleId' | 'workflow'>> = {}
): HostResult<{ task: Task }> {
  const { worktree } = launched;
  if (worktree) {
    const inserted = store.worktrees.insert(worktree);
    if (!inserted.ok) return inserted;
  }
  const dropWorktree = () => {
    if (worktree) store.worktrees.delete(worktree.id);
  };
  const dispatch = store.dispatches.insert(launched.dispatch);
  if (!dispatch.ok) {
    dropWorktree();
    return dispatch;
  }
  const saved = isNew
    ? store.tasks.insert({ ...task, ...patch, status: 'in-progress' })
    : store.tasks.update(task.id, { ...patch, status: 'in-progress' });
  if (!saved.ok) {
    store.dispatches.delete(launched.dispatch.id);
    dropWorktree();
    return saved;
  }
  return { ok: true, task: saved.value };
}
