import type { HostResult } from '@fynvra/agent-runtime';
import {
  type Dispatch,
  describeWorkflowHistory,
  describeWorkflowStep,
  type Inbox,
  isDispatchSettled,
  newId,
  type OrchestrationStore,
  type Task,
  type TaskWorkflow,
  type Workspace,
  type Worktree,
  withoutPending,
  workflowBriefContext,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { recordAttempt, startAttemptSession } from './attempt';
import { renderWorkerBrief } from './brief';
import { fail } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';

/** 引擎自己投递的 worker_done 的发送方（同 host.ts 的 HOST_SENDER） */
const ENGINE_SENDER = 'fynvra';
const IDLE_POLL_MS = 1_000;
/** 上一步会话迟迟不空闲时最多等这么久，然后照常释放（dispose 会中止它）并启动下一步 */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_LISTED_FILES = 100;

export interface WorkflowEngineDeps {
  workspace: Workspace;
  store: OrchestrationStore;
  inbox: Inbox;
  launcher: WorkerSessionLauncher;
  now: () => number;
  log: (message: string) => void;
  /** 可启动 worker 会话（launcher 已接线）；false 时 resume 什么也不做，等接线后的对账再来 */
  canLaunch?: () => boolean;
  idlePollMs?: number;
  idleTimeoutMs?: number;
}

/**
 * 工作流推进（ARCHITECTURE §6 编排状态机之上）：report_done 结算后由 WorkerHost 写下 `workflow.pending`，
 * 引擎再异步执行它——等上一步会话空闲后释放它，在同一 worktree（普通目录则同一目录）为目标步骤的角色起新会话，
 * 紧跟着同步落库新 Dispatch，并把 task 的 roleId / step 更新、pending 清掉。
 */
export interface WorkflowEngine {
  /** 异步执行任务的 pending 推进，不阻塞调用方、从不抛；正在推进的任务不会重复执行。启动失败时任务记 failed 并投 worker_done。 */
  advance(taskId: string): void;
  /** reject_work 用：执行 pending 推进并等待结果；失败时不改任务（由调用方回滚）。 */
  start(taskId: string): Promise<HostResult<{ dispatch: Dispatch }>>;
  isAdvancing(taskId: string): boolean;
  /** 服务加载 / 对账：重新执行处于 in-progress、当前尝试已结算且有 pending 的任务。 */
  resume(): void;
}

type Failure = { ok: false; error: string; fatal: boolean };
type Ready = { task: Task & { workflow: TaskWorkflow }; previous: Dispatch };

/** 各步汇报的改动文件并集（按汇报顺序去重）。 */
function unionFiles(store: OrchestrationStore, taskId: string): string[] {
  const attempts = store.dispatches.list((dispatch) => dispatch.taskId === taskId);
  return [...new Set(attempts.flatMap((dispatch) => dispatch.filesModified ?? []))];
}

/**
 * 工作流结束时给主 agent 的 worker_done 正文：结论、各步历程、各步改动文件的并集。
 * `reason` 是额外说明（如下一步启动失败的原因）。
 */
export function workflowDoneBody(
  store: OrchestrationStore,
  task: Task & { workflow: TaskWorkflow },
  outcome: 'succeeded' | 'failed',
  reason?: string
): string {
  const workflow = task.workflow;
  const headline =
    outcome === 'succeeded'
      ? `Workflow "${workflow.name}" finished: its last step passed (rounds ${workflow.rounds}/${workflow.maxRounds}). Review, check and merge as usual.`
      : `Workflow "${workflow.name}" failed at step ${describeWorkflowStep(workflow, workflow.step)} (rounds ${workflow.rounds}/${workflow.maxRounds}).`;
  const files = unionFiles(store, task.id);
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => `- ${file}`);
  if (files.length > MAX_LISTED_FILES)
    listed.push(`- … and ${files.length - MAX_LISTED_FILES} more`);
  return [
    headline,
    ...(reason ? ['', reason] : []),
    '',
    '## Workflow history',
    '',
    describeWorkflowHistory(workflow),
    ...(files.length > 0
      ? ['', `Files modified across all steps (${files.length}):`, ...listed]
      : []),
  ].join('\n');
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const { workspace, store, inbox, launcher, now, log } = deps;
  const pollMs = deps.idlePollMs ?? IDLE_POLL_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const running = new Set<string>();

  const latest = (taskId: string): Dispatch | undefined =>
    store.dispatches.list((dispatch) => dispatch.taskId === taskId).at(-1);

  /** 可推进：任务 in-progress、有 pending、当前尝试已结算。 */
  function readyOf(taskId: string): Ready | undefined {
    const task = store.tasks.get(taskId);
    if (task?.status !== 'in-progress' || task.workflow?.pending === undefined) return undefined;
    const previous = latest(taskId);
    if (previous === undefined || !isDispatchSettled(previous)) return undefined;
    return { task: task as Ready['task'], previous };
  }

  const samePending = (a: TaskWorkflow, b: TaskWorkflow): boolean =>
    a.pending?.step === b.pending?.step && a.pending?.feedback === b.pending?.feedback;

  /** 推进期间任务没有被别人改过（放弃、清理、另一次推进）。 */
  function stillReady(taskId: string, expected: Ready): Ready | undefined {
    const ready = readyOf(taskId);
    if (
      ready === undefined ||
      ready.previous.id !== expected.previous.id ||
      !samePending(ready.task.workflow, expected.task.workflow)
    ) {
      return undefined;
    }
    return ready;
  }

  async function dispose(sessionId: string): Promise<void> {
    try {
      await launcher.disposeSession(sessionId);
    } catch {
      // 会话可能已经不在了
    }
  }

  /** 等上一步的 worker 会话结束当前 run（report_done 之后它通常马上收尾）；读不到时视为空闲。 */
  async function waitIdle(sessionId: string): Promise<void> {
    const deadline = Date.now() + idleTimeoutMs;
    for (;;) {
      let idle = true;
      try {
        const read = await launcher.readTranscript(sessionId, Number.MAX_SAFE_INTEGER);
        idle = !read.ok || read.done;
      } catch {
        idle = true;
      }
      if (idle || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function run(taskId: string): Promise<HostResult<{ dispatch: Dispatch }> | Failure> {
    const changed = (): Failure => ({
      ok: false,
      error: `task ${taskId} changed while its next workflow step was starting`,
      fatal: false,
    });
    const first = readyOf(taskId);
    if (first === undefined) {
      return { ok: false, error: `task ${taskId} has no pending workflow step`, fatal: false };
    }
    // 上一步的会话：空闲后按现有方式释放；它的 dispatch 与 pi jsonl 保留，read_worker_output 仍可读
    await waitIdle(first.previous.workerSessionId);
    await dispose(first.previous.workerSessionId);

    const ready = stillReady(taskId, first);
    if (ready === undefined) return changed();
    const { task, previous } = ready;
    const workflow = task.workflow;
    const target = workflow.pending?.step ?? -1;
    const step = workflow.steps[target];
    if (step === undefined) {
      return { ok: false, error: `workflow step ${target + 1} does not exist`, fatal: true };
    }
    let worktree: Worktree | undefined;
    if (previous.mode !== 'in-place') {
      worktree = store.worktrees.get(previous.worktreeId);
      if (worktree === undefined) {
        return {
          ok: false,
          error: `the worktree of dispatch ${previous.id} was already cleaned up`,
          fatal: true,
        };
      }
    }
    const dispatchId = newId('dispatch');
    const brief = renderWorkerBrief({
      title: task.title,
      spec: task.spec,
      dispatchId,
      workflow: workflowBriefContext(workflow, target, workflow.pending?.feedback),
    });
    const started = await startAttemptSession(
      { workspace, launcher, now },
      { ...task, roleId: step.roleId },
      { dispatchId, worktree, brief }
    );
    if (!started.ok) {
      return {
        ok: false,
        error: `could not start workflow step ${describeWorkflowStep(workflow, target)}: ${started.error}`,
        fatal: true,
      };
    }
    // 必须紧跟在 launcher resolve 之后同步落库，中间不能有 await（同 host.start）：
    // worker 的 report_done / ask_coordinator 经 Dispatch.workerSessionId 找到这次尝试
    const current = stillReady(taskId, ready);
    if (current === undefined) {
      void dispose(started.dispatch.workerSessionId);
      return changed();
    }
    const recorded = recordAttempt(
      store,
      current.task,
      { worktree: undefined, dispatch: started.dispatch },
      false,
      {
        roleId: step.roleId,
        workflow: { ...withoutPending(current.task.workflow), step: target },
      }
    );
    if (!recorded.ok) {
      void dispose(started.dispatch.workerSessionId);
      return { ok: false, error: recorded.error, fatal: true };
    }
    return { ok: true, dispatch: started.dispatch };
  }

  /** 推进失败：任务记 failed（清掉 pending），给主 agent 投 worker_done(failed) 说明原因与历程。 */
  function failTask(taskId: string, previousId: string | undefined, reason: string): void {
    const task = store.tasks.get(taskId);
    if (task?.workflow === undefined || task.status !== 'in-progress') return;
    const previous = latest(taskId);
    if (previous === undefined || previous.id !== previousId || !isDispatchSettled(previous))
      return;
    const workflow = withoutPending(task.workflow);
    const moved = store.tasks.update(taskId, { status: 'failed', workflow });
    if (!moved.ok) {
      log(`workflow task ${taskId}: could not record the failure: ${moved.error}`);
      return;
    }
    const run = store.runs.get(task.runId);
    if (run === undefined) return;
    inbox.post({
      runId: run.id,
      dispatchId: previous.id,
      from: ENGINE_SENDER,
      to: run.coordinatorSessionId,
      type: 'worker_done',
      subject: 'failed',
      body: workflowDoneBody(store, { ...task, workflow }, 'failed', reason),
    });
  }

  function advance(taskId: string): void {
    if (running.has(taskId)) return;
    running.add(taskId);
    const previousId = latest(taskId)?.id;
    void (async () => {
      let retry = false;
      try {
        const result = await run(taskId);
        if (!result.ok) {
          if ('fatal' in result && result.fatal) failTask(taskId, previousId, result.error);
          // 推进途中状态被改成了另一个可推进的状态：按新状态再来一次
          else retry = readyOf(taskId) !== undefined;
        }
      } catch (error) {
        log(`workflow task ${taskId}: ${errorMessage(error)}`);
        failTask(taskId, previousId, `Advancing the workflow failed: ${errorMessage(error)}`);
      } finally {
        running.delete(taskId);
      }
      if (retry) advance(taskId);
    })();
  }

  return {
    advance,
    async start(taskId) {
      if (running.has(taskId)) return fail(`task ${taskId} is already starting a workflow step`);
      running.add(taskId);
      try {
        const result = await run(taskId);
        return result.ok ? result : fail(result.error);
      } catch (error) {
        return fail(errorMessage(error));
      } finally {
        running.delete(taskId);
      }
    },
    isAdvancing: (taskId) => running.has(taskId),
    resume() {
      if (deps.canLaunch && !deps.canLaunch()) return;
      for (const task of store.tasks.list(
        (entry) => entry.status === 'in-progress' && entry.workflow?.pending !== undefined
      )) {
        if (!running.has(task.id) && readyOf(task.id) !== undefined) advance(task.id);
      }
    },
  };
}
