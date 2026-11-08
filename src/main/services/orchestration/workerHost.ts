import type { WorkerHost } from '@fynvra/agent-runtime';
import {
  type Inbox,
  isDispatchSettled,
  type OrchestrationStore,
  recordWorkflowNodeReport,
  settleDispatch,
  workflowNodeOfDispatch,
  workflowStep,
} from '@fynvra/core';
import { ABORTED, fail, guard, untilAborted } from './hostResult';

/** ARCHITECTURE §9.5 `createWorkerHost` 的依赖；`now` 是补充的可注入时钟。 */
export interface WorkerHostDeps {
  store: OrchestrationStore;
  inbox: Inbox;
  runId: string;
  dispatchId: string;
  now?: () => number;
  /**
   * 工作流任务的推进：reportDone 把节点结果落库后调用，异步执行、不阻塞 report_done。
   * 缺省时等服务加载或对账时恢复。
   */
  advanceWorkflow?: (taskId: string) => void;
}

// 正阻塞在 ask_coordinator 里等答复的问题：question 消息 id → 提问的 worker 会话。
// 这是进程内的运行时状态，跟着收件箱走：同一个 Inbox 上的 OrchestrationHost 据此决定
// send_to_worker 发 reply 还是 instruction。重启后没有阻塞中的提问者，表自然是空的。
const pendingAsks = new WeakMap<Inbox, Map<string, string>>();

function asksOf(inbox: Inbox): Map<string, string> {
  let asks = pendingAsks.get(inbox);
  if (asks === undefined) {
    asks = new Map();
    pendingAsks.set(inbox, asks);
  }
  return asks;
}

/** 该 worker 会话正阻塞等待答复的最早一个问题（question 消息 id）。 */
export function pendingQuestionOf(inbox: Inbox, workerSessionId: string): string | undefined {
  for (const [questionId, sessionId] of asksOf(inbox)) {
    if (sessionId === workerSessionId) return questionId;
  }
  return undefined;
}

/** 问题已答复：立刻摘掉（提问者要到下一个微任务才醒），同一问题不会被答两次。 */
export function takePendingQuestion(inbox: Inbox, questionId: string): void {
  asksOf(inbox).delete(questionId);
}

function normalizeFiles(files: readonly string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined;
  return [...new Set(files.map((file) => file.trim()).filter((file) => file !== ''))];
}

function describeReport(summary: string, files: readonly string[] | undefined): string {
  const body = summary.trim();
  if (files === undefined || files.length === 0) return body;
  const list = files.map((file) => `- ${file}`).join('\n');
  return `${body}\n\nFiles modified (${files.length}):\n${list}`;
}

/**
 * worker 工具背后的宿主（ARCHITECTURE §9.5），绑定一次尝试（dispatch）：
 * - `askCoordinator`：投 `question` 给 coordinator，等 `replyTo` 指向它的 `reply`；超时 `answer: null`。
 * - `reportDone`：结算 dispatch（succeeded → task `in-review`，failed → `failed`）再投 `worker_done`。
 *   每个 attempt 只能成功报告一次；重复或过期报告不转发，也不改写历史。
 */
export function createWorkerHost(deps: WorkerHostDeps): WorkerHost {
  const { store, inbox, runId, dispatchId } = deps;
  const now = deps.now ?? Date.now;

  const context = () => {
    const dispatch = store.dispatches.get(dispatchId);
    const task = dispatch && store.tasks.get(dispatch.taskId);
    const run = store.runs.get(runId);
    if (dispatch === undefined || task === undefined)
      return fail(`dispatch ${dispatchId} not found`);
    if (run === undefined || task.runId !== run.id) {
      return fail(`dispatch ${dispatchId} does not belong to run ${runId}`);
    }
    if (task.workflow !== undefined) {
      // 工作流：可能有多个节点同时运行，绑定在运行中节点上的 dispatch 才是当前尝试
      const node = workflowNodeOfDispatch(task.workflow, dispatch.id);
      if (node?.status !== 'running') {
        return fail(`dispatch ${dispatch.id} is not a running node of workflow task ${task.id}`);
      }
      return { ok: true as const, dispatch, task, run };
    }
    const current = store.dispatches.list((entry) => entry.taskId === task.id).at(-1);
    if (current?.id !== dispatch.id) {
      return fail(`dispatch ${dispatch.id} was superseded by ${current?.id}`);
    }
    return { ok: true as const, dispatch, task, run };
  };

  return {
    askCoordinator: (question, timeoutMs, signal) =>
      guard(async () => {
        const body = question.trim();
        if (body === '') return fail('question must not be empty');
        const found = context();
        if (!found.ok) return found;
        const { dispatch, task, run } = found;
        // 工作流节点的提问带上工作流名与节点名，主 agent 才分得清是哪个节点在问
        const node = task.workflow && workflowNodeOfDispatch(task.workflow, dispatch.id);
        const where =
          task.workflow && node
            ? `[Workflow "${task.workflow.name}" · node "${workflowStep(task.workflow, node.id)?.name ?? node.id}"] `
            : '';
        const posted = inbox.post({
          runId: run.id,
          dispatchId: dispatch.id,
          from: dispatch.workerSessionId,
          to: run.coordinatorSessionId,
          type: 'question',
          body: `${where}${body}`,
        });
        if (!posted.ok) return posted;
        const questionId = posted.message.id;
        const asks = asksOf(inbox);
        asks.set(questionId, dispatch.workerSessionId);
        try {
          const reply = await untilAborted(
            inbox.waitFor({ types: ['reply'], replyTo: questionId }, timeoutMs),
            signal
          );
          if (reply === ABORTED) return fail('ask_coordinator was aborted');
          if (reply === null) return { ok: true, answer: null };
          inbox.ack(reply.id);
          return { ok: true, answer: reply.body };
        } finally {
          asks.delete(questionId);
        }
      }),

    reportDone: (outcome, summary, filesModified) =>
      guard(async () => {
        const found = context();
        if (!found.ok) return found;
        const { dispatch, task, run } = found;
        const files = normalizeFiles(filesModified);
        const message = {
          runId: run.id,
          dispatchId: dispatch.id,
          from: dispatch.workerSessionId,
          to: run.coordinatorSessionId,
          type: 'worker_done' as const,
          body: describeReport(summary, files),
        };

        if (isDispatchSettled(dispatch)) {
          return fail(
            `report_done was already recorded for attempt ${dispatch.id}; use reject_work for a new attempt`
          );
        }
        if (task.status !== 'in-progress') {
          return fail(`task ${task.id} is ${task.status}; this attempt can no longer be reported`);
        }

        const settled = settleDispatch(dispatch, outcome, summary.trim(), files, now());
        if (!settled.ok) return settled;
        const { id: _id, ...patch } = settled.dispatch;
        const updated = store.dispatches.update(dispatch.id, patch);
        if (!updated.ok) return updated;
        if (task.workflow !== undefined) {
          // 工作流：节点结果落库、任务保持 in-progress，再由引擎异步合并 / 调度 / 汇总；
          // 主 agent 只在整个工作流结束时收到引擎投的 worker_done
          const next = recordWorkflowNodeReport(task.workflow, {
            dispatchId: dispatch.id,
            outcome,
            summary,
            at: settled.dispatch.settledAt ?? now(),
          });
          if (next === undefined) {
            return fail(`dispatch ${dispatch.id} is not a running node of task ${task.id}`);
          }
          const kept = store.tasks.update(task.id, { workflow: next });
          if (!kept.ok) return kept;
          deps.advanceWorkflow?.(task.id);
          return { ok: true };
        }
        const status = outcome === 'succeeded' ? 'in-review' : 'failed';
        const moved = store.tasks.update(task.id, { status });
        if (!moved.ok) return moved;
        // 先结算再投递：等在 wait_for_workers 里的 coordinator 醒来时 pending 已经是新值
        const posted = inbox.post({ ...message, subject: outcome });
        return posted.ok ? { ok: true } : posted;
      }),
  };
}
