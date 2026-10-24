import type { Dispatch, Message, MessageType, Task } from '@fynvra/core';

/**
 * Host 调用结果。Host 不向工具抛异常：失败一律 `{ ok: false, error }`，
 * 工具再把它转成给模型的错误文本（工具 execute 永不抛）。
 */
export type HostResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** worker 汇报的结果，与 `Dispatch.outcome` 一致 */
export type DispatchOutcome = NonNullable<Dispatch['outcome']>;

/** `wait_for_workers` 的结束条件 */
export type WaitUntil = 'any' | 'all';

export interface DispatchTaskInput {
  title: string;
  spec: string;
  /** 已归一化的角色 id，未指定时为 `'worker'` */
  roleId: string;
  /** 必须先完成（合并）的 task id */
  dependsOn: string[];
}
export interface DispatchTaskOutput {
  task: Task;
  /** 依赖未满足时 Main 只建 Task 并排队，此时没有 Dispatch */
  dispatch?: Dispatch;
}

export interface WorkerEntry {
  task: Task;
  /** 当前（或最近一次）Dispatch；排队中的任务没有 */
  dispatch?: Dispatch;
}
export interface ListWorkersOutput {
  workers: WorkerEntry[];
}

export interface WaitForWorkersInput {
  /** 已 clamp 到 [1000, 900000] */
  timeoutMs: number;
  until: WaitUntil;
}
export interface WaitForWorkersOutput {
  /** 到时仍未满足 `until` */
  timedOut: boolean;
  /**
   * 本次等待期间送达 coordinator 的消息（worker_done / question / escalation ...）。
   * question / escalation 到达时应立即返回，否则阻塞提问的 worker 会和等待中的主 agent 互等。
   */
  messages: Message[];
  /** 仍在运行（未 settle）的 dispatch 数 */
  pending: number;
}

export interface ReadWorkerOutputInput {
  dispatchId: string;
  /** 字符偏移，从 0 开始 */
  cursor: number;
}
export interface ReadWorkerOutputOutput {
  /** 从 cursor 开始的 worker 输出文本（Host 可自行截断，工具会再按自身上限截断） */
  text: string;
  /** 输出总长度（字符），用于计算下一个 cursor */
  total: number;
  /** worker 已 settle，不会再有新输出 */
  done: boolean;
}

export interface SendToWorkerInput {
  dispatchId: string;
  body: string;
}
export interface SendToWorkerOutput {
  messageId: string;
  /** `'reply'`：回答了 worker 挂起的 ask_coordinator；`'instruction'`：普通指示 */
  type: MessageType;
}

export interface DispatchRef {
  dispatchId: string;
}

export interface ReviewDiffOutput {
  branch: string;
  baseCommit: string;
  files: string[];
  /** `git diff --stat` 文本 */
  stat: string;
  /** 完整 diff 文本（工具负责截断） */
  diff: string;
}

export interface RunChecksInput {
  dispatchId: string;
  command: string;
}
export interface RunChecksOutput {
  exitCode: number;
  /** stdout + stderr 合并输出（工具保留尾部） */
  output: string;
  durationMs: number;
}

export interface MergeWorktreeOutput {
  merged: boolean;
  /** 合并目标（主 agent 所在分支） */
  targetBranch: string;
  commit?: string;
  /** merged=false 时的冲突文件；Host 已 `merge --abort` */
  conflicts?: string[];
}

export interface RejectWorkInput {
  dispatchId: string;
  feedback: string;
}
export interface RejectWorkOutput {
  messageId: string;
}

export interface CleanupWorktreeOutput {
  removedWorktree: boolean;
  deletedBranch: boolean;
}

/**
 * 编排工具背后的宿主接口，方法与 orchestrator 工具一一对应（见 {@link ORCHESTRATION_TOOL_METHODS}）。
 *
 * 工具不直接操作 git / 进程；由 Main 实现（agent worker 进程里是转发到 Main 的代理），
 * 与 EnsoCode 的 `AgentControlInvoker` 同构。`signal` 在模型本轮被中止时触发，阻塞类方法应尽快返回。
 */
export interface OrchestrationHost {
  dispatchTask(
    input: DispatchTaskInput,
    signal?: AbortSignal
  ): Promise<HostResult<DispatchTaskOutput>>;
  listWorkers(signal?: AbortSignal): Promise<HostResult<ListWorkersOutput>>;
  waitForWorkers(
    input: WaitForWorkersInput,
    signal?: AbortSignal
  ): Promise<HostResult<WaitForWorkersOutput>>;
  readWorkerOutput(
    input: ReadWorkerOutputInput,
    signal?: AbortSignal
  ): Promise<HostResult<ReadWorkerOutputOutput>>;
  sendToWorker(
    input: SendToWorkerInput,
    signal?: AbortSignal
  ): Promise<HostResult<SendToWorkerOutput>>;
  reviewDiff(input: DispatchRef, signal?: AbortSignal): Promise<HostResult<ReviewDiffOutput>>;
  runChecks(input: RunChecksInput, signal?: AbortSignal): Promise<HostResult<RunChecksOutput>>;
  mergeWorktree(input: DispatchRef, signal?: AbortSignal): Promise<HostResult<MergeWorktreeOutput>>;
  rejectWork(input: RejectWorkInput, signal?: AbortSignal): Promise<HostResult<RejectWorkOutput>>;
  cleanupWorktree(
    input: DispatchRef,
    signal?: AbortSignal
  ): Promise<HostResult<CleanupWorktreeOutput>>;
}

/** 编排工具名 → OrchestrationHost 方法名（一一对应） */
export const ORCHESTRATION_TOOL_METHODS = {
  dispatch_task: 'dispatchTask',
  list_workers: 'listWorkers',
  wait_for_workers: 'waitForWorkers',
  read_worker_output: 'readWorkerOutput',
  send_to_worker: 'sendToWorker',
  review_diff: 'reviewDiff',
  run_checks: 'runChecks',
  merge_worktree: 'mergeWorktree',
  reject_work: 'rejectWork',
  cleanup_worktree: 'cleanupWorktree',
} as const satisfies Record<string, keyof OrchestrationHost>;

export type OrchestrationToolName = keyof typeof ORCHESTRATION_TOOL_METHODS;

/** worker 工具背后的宿主接口 */
export interface WorkerHost {
  /**
   * 向 coordinator 提问并阻塞等待答复（Inbox: question → reply）。
   * 超时返回 `{ ok: true, answer: null }`，不是错误。
   */
  askCoordinator(
    question: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<HostResult<{ answer: string | null }>>;
  /** 汇报完成（Inbox: worker_done，并 settle 当前 Dispatch） */
  reportDone(
    outcome: DispatchOutcome,
    summary: string,
    filesModified?: string[]
  ): Promise<HostResult>;
}
