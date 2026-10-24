import { type DispatchOutcome, isDispatchOutcome, isTaskStatus } from '../guards';
import type { Dispatch, Task, TaskStatus } from '../types';

/**
 * 任务状态合法迁移表（ARCHITECTURE §6）：
 * - `todo` → `in-progress`（派发）| `abandoned`
 * - `in-progress` → `in-review`（worker 报告成功）| `failed`（报告失败）| `abandoned`
 * - `in-review` → `completed`（验收合并）| `in-progress`（打回继续改）| `failed` | `abandoned`
 * - `failed` → `in-progress`（重试）| `abandoned`
 * - `completed`、`abandoned` 是终态。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  todo: Object.freeze(['in-progress', 'abandoned'] as const),
  'in-progress': Object.freeze(['in-review', 'failed', 'abandoned'] as const),
  'in-review': Object.freeze(['completed', 'in-progress', 'failed', 'abandoned'] as const),
  failed: Object.freeze(['in-progress', 'abandoned'] as const),
  completed: Object.freeze([] as const),
  abandoned: Object.freeze([] as const),
});

/** `from` → `to` 是否合法；同状态、未知状态都返回 `false`。 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return isTaskStatus(from) && isTaskStatus(to) && TASK_TRANSITIONS[from].includes(to);
}

/** 是否终态（没有任何合法后继）。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return isTaskStatus(status) && TASK_TRANSITIONS[status].length === 0;
}

/** {@link applyTaskTransition} 的结果。 */
export type TaskTransitionResult = { ok: true; task: Task } | { ok: false; error: string };

/** 把任务迁移到 `to`，返回新对象；非法迁移返回错误而不是抛异常，入参不变。 */
export function applyTaskTransition(task: Task, to: TaskStatus): TaskTransitionResult {
  if (!isTaskStatus(to)) return { ok: false, error: `unknown task status: ${JSON.stringify(to)}` };
  if (!canTransitionTask(task.status, to)) {
    return { ok: false, error: `task ${task.id}: illegal transition ${task.status} → ${to}` };
  }
  return { ok: true, task: { ...task, status: to } };
}

/** dispatch 是否已结算（有 `settledAt`）。 */
export function isDispatchSettled(dispatch: Dispatch): boolean {
  return dispatch.settledAt !== undefined;
}

/** {@link settleDispatch} 的结果。 */
export type SettleDispatchResult = { ok: true; dispatch: Dispatch } | { ok: false; error: string };

/**
 * 结算一次尝试（worker 的 `report_done`），返回新对象。每个 dispatch 只能结算一次，
 * 重复结算或非法 `outcome` 返回错误；入参不变。
 *
 * @param now - 结算时间（epoch ms），默认 `Date.now()`。
 */
export function settleDispatch(
  dispatch: Dispatch,
  outcome: DispatchOutcome,
  summary: string,
  filesModified?: readonly string[],
  now: number = Date.now()
): SettleDispatchResult {
  if (isDispatchSettled(dispatch)) {
    return {
      ok: false,
      error: `dispatch ${dispatch.id} is already settled (${dispatch.outcome ?? 'unknown'})`,
    };
  }
  if (!isDispatchOutcome(outcome)) {
    return {
      ok: false,
      error: `outcome must be 'succeeded' or 'failed', got ${JSON.stringify(outcome)}`,
    };
  }
  return {
    ok: true,
    dispatch: {
      ...dispatch,
      settledAt: now,
      outcome,
      summary,
      ...(filesModified === undefined ? {} : { filesModified: [...filesModified] }),
    },
  };
}
