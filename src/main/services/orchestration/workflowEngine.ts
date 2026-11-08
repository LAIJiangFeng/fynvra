import type { HostResult } from '@fynvra/agent-runtime';
import {
  BRANCH_PREFIX,
  type Dispatch,
  describeWorkflowHistory,
  describeWorkflowNodes,
  type ExecFn,
  failWorkflowNode,
  type GitWorktreeManager,
  type Inbox,
  isDispatchSettled,
  isUnmerged,
  markWorkflowNodeMerged,
  newId,
  normalizeSlug,
  type OrchestrationStore,
  planWorkflow,
  summarizeTaskWorkflow,
  type Task,
  type TaskWorkflow,
  type TaskWorkflowLaunch,
  type TaskWorkflowNodeState,
  WORKFLOW_SUMMARY_MAX,
  type Workspace,
  type Worktree,
  withWorkflowLaunches,
  workflowBriefContext,
  workflowNodeState,
  workflowStep,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { startAttemptSession } from './attempt';
import { renderWorkerBrief } from './brief';
import { fail } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';

/** 引擎自己投递的 worker_done 的发送方（同 host.ts 的 HOST_SENDER） */
const ENGINE_SENDER = 'fynvra';
const IDLE_POLL_MS = 1_000;
/** 已结算节点的会话迟迟不空闲时最多等这么久，然后照常释放（dispose 会中止它） */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_LISTED_FILES = 100;
/** 一次推进最多走这么多步（防御：每一步都会改变状态，正常远到不了） */
const MAX_PUMP_STEPS = 200;

export interface WorkflowEngineDeps {
  workspace: Workspace;
  store: OrchestrationStore;
  inbox: Inbox;
  launcher: WorkerSessionLauncher;
  /** 节点 worktree 的创建 / 合并 / 清理（与 Host 共用同一个实现） */
  git: GitWorktreeManager;
  exec: ExecFn;
  /** 节点 worktree 的托管根目录（同 Host） */
  resolveWorktreesRoot: (workspace: Workspace) => Promise<string>;
  now: () => number;
  log: (message: string) => void;
  /** 可启动 worker 会话（launcher 已接线）；false 时 resume 什么也不做，等接线后的对账再来 */
  canLaunch?: () => boolean;
  idlePollMs?: number;
  idleTimeoutMs?: number;
}

/**
 * 工作流的图调度（ARCHITECTURE §7.13）。每个任务一个串行的推进循环（pump）：
 * 落实待启动意图 → 释放已结算节点的会话、把通过的隔离节点合回集成 worktree → 按 {@link planWorkflow}
 * 启动可运行的节点 / 汇总失败后退回 / 结束任务并投 worker_done。所有状态先落库再动手，崩溃后按快照恢复。
 */
export interface WorkflowEngine {
  /** 异步推进任务，不阻塞调用方、从不抛；正在推进的任务记一笔，当前循环结束后再走一轮。 */
  advance(taskId: string): void;
  /**
   * 派发 / reject_work 用：启动首批节点并等待结果。任一节点启动失败时撤掉本次启动的会话、dispatch 与节点 worktree，
   * 在同一临界区里调用 `rollback`（由调用方还原任务）后返回错误。
   */
  start(taskId: string, rollback: () => void): Promise<HostResult<{ dispatches: Dispatch[] }>>;
  isAdvancing(taskId: string): boolean;
  /** 服务加载 / 对账：修补旧快照，推进所有 in-progress 的工作流任务。 */
  resume(): void;
  /** abandon / cleanup / 整图重跑前：释放所有节点会话，删掉集成 worktree 以外的节点 worktree 与分支。 */
  discardNodes(taskId: string): Promise<string>;
}

type WorkflowTask = Task & { workflow: TaskWorkflow };

/** 各节点汇报的改动文件并集（按汇报顺序去重）。 */
function unionFiles(store: OrchestrationStore, taskId: string): string[] {
  const attempts = store.dispatches.list((dispatch) => dispatch.taskId === taskId);
  return [...new Set(attempts.flatMap((dispatch) => dispatch.filesModified ?? []))];
}

/**
 * 工作流结束时给主 agent 的 worker_done 正文：结论、各节点状态、历程、改动文件的并集。
 * `reason` 是额外说明。
 */
export function workflowDoneBody(
  store: OrchestrationStore,
  task: WorkflowTask,
  outcome: 'succeeded' | 'failed',
  reason?: string
): string {
  const workflow = task.workflow;
  const rounds = `rounds ${workflow.rounds}/${workflow.maxRounds}`;
  const headline =
    outcome === 'succeeded'
      ? `Workflow "${workflow.name}" finished: every node passed and was merged into the task worktree (${rounds}). Review, check and merge this dispatch as usual; it covers the combined result.`
      : `Workflow "${workflow.name}" failed (${rounds}).`;
  const files = unionFiles(store, task.id);
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => `- ${file}`);
  if (files.length > MAX_LISTED_FILES)
    listed.push(`- … and ${files.length - MAX_LISTED_FILES} more`);
  return [
    headline,
    ...(reason ? ['', reason] : []),
    '',
    `Graph: ${summarizeTaskWorkflow(workflow)}`,
    '',
    '## Nodes',
    '',
    ...describeWorkflowNodes(workflow).map((line) => `- ${line}`),
    '',
    '## Workflow history',
    '',
    describeWorkflowHistory(workflow),
    ...(files.length > 0
      ? ['', `Files modified across all nodes (${files.length}):`, ...listed]
      : []),
  ].join('\n');
}

/** 节点分支的 slug：`<任务分支 slug>-<节点 id>`，看得出属于哪个任务、哪个节点。 */
function nodeSlug(integration: Worktree | undefined, title: string, nodeId: string): string {
  const base = integration?.branch.startsWith(BRANCH_PREFIX)
    ? integration.branch.slice(BRANCH_PREFIX.length)
    : normalizeSlug(title);
  const node = normalizeSlug(nodeId).slice(0, 16).replace(/-+$/, '');
  return `${base.slice(0, 40 - node.length - 1).replace(/-+$/, '')}-${node}`;
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const { workspace, store, inbox, launcher, git, exec, now, log } = deps;
  const repoPath = workspace.repoPath;
  const isolate = workspace.vcs !== 'none';
  const pollMs = deps.idlePollMs ?? IDLE_POLL_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const busy = new Set<string>();
  const again = new Set<string>();
  /** 已释放会话的 dispatch（进程内；重启后会话本来就不在了，重复释放无害） */
  const released = new Set<string>();

  function workflowTask(taskId: string): WorkflowTask | undefined {
    const task = store.tasks.get(taskId);
    return task?.workflow === undefined ? undefined : (task as WorkflowTask);
  }

  function activeTask(taskId: string): WorkflowTask | undefined {
    const task = workflowTask(taskId);
    return task?.status === 'in-progress' ? task : undefined;
  }

  /** 读最新状态 → 变换 → 写回（同步，中间没有 await）；任务不在 in-progress 或变换放弃时返回 false。 */
  function mutate(
    taskId: string,
    change: (workflow: TaskWorkflow, task: WorkflowTask) => TaskWorkflow | undefined,
    extra: Partial<Pick<Task, 'roleId' | 'status'>> = {}
  ): boolean {
    const task = activeTask(taskId);
    if (task === undefined) return false;
    const next = change(task.workflow, task);
    if (next === undefined) return false;
    const saved = store.tasks.update(taskId, { ...extra, workflow: next });
    if (!saved.ok) log(`workflow task ${taskId}: ${saved.error}`);
    return saved.ok;
  }

  async function dispose(sessionId: string): Promise<void> {
    try {
      await launcher.disposeSession(sessionId);
    } catch {
      // 会话可能已经不在了
    }
  }

  /** 等节点 worker 会话结束当前 run（report_done 之后它通常马上收尾）；读不到时视为空闲。 */
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

  /** 已结算节点的会话：空闲后释放；它的 dispatch 与 pi jsonl 保留，read_worker_output 仍可读。 */
  async function release(dispatchId: string | undefined): Promise<void> {
    if (dispatchId === undefined || released.has(dispatchId)) return;
    const dispatch = store.dispatches.get(dispatchId);
    if (dispatch === undefined || !isDispatchSettled(dispatch)) return;
    await waitIdle(dispatch.workerSessionId);
    await dispose(dispatch.workerSessionId);
    released.add(dispatchId);
  }

  async function releaseSettled(taskId: string): Promise<void> {
    const task = workflowTask(taskId);
    if (task === undefined) return;
    for (const node of task.workflow.nodes) {
      if (node.status !== 'running') await release(node.dispatchId);
    }
  }

  /** 删掉节点 worktree 与分支（尽力而为），并删掉它的记录；返回失败说明。 */
  async function removeNodeWorktree(worktreeId: string | undefined): Promise<string> {
    const worktree = worktreeId === undefined ? undefined : store.worktrees.get(worktreeId);
    if (worktree === undefined) return '';
    const removed = await git.remove({ repoPath, path: worktree.path, force: true });
    const deleted = await git.deleteBranch({ repoPath, branch: worktree.branch, force: true });
    if (removed.ok) store.worktrees.delete(worktree.id);
    const problems = [removed, deleted].flatMap((result) => (result.ok ? [] : [result.error]));
    return problems.join('; ');
  }

  function integrationOf(workflow: TaskWorkflow): Worktree | undefined {
    return workflow.worktreeId === undefined ? undefined : store.worktrees.get(workflow.worktreeId);
  }

  // ---- 待启动意图 ----

  type LaunchResult = { ok: true; dispatch?: Dispatch } | { ok: false; error: string };

  /** 落实一条启动意图：已有对应 dispatch 时只补状态；否则（必要时建节点 worktree）起会话并同步落库。 */
  async function runLaunch(taskId: string, launch: TaskWorkflowLaunch): Promise<LaunchResult> {
    const pendingLaunch = (workflow: TaskWorkflow) =>
      workflow.launches.find((entry) => entry.dispatchId === launch.dispatchId);
    const finish = (workflow: TaskWorkflow, worktreeId: string | undefined): TaskWorkflow => ({
      ...workflow,
      launches: workflow.launches.filter((entry) => entry.dispatchId !== launch.dispatchId),
      nodes: workflow.nodes.map((node): TaskWorkflowNodeState => {
        if (node.id !== launch.nodeId) return node;
        const { feedback: _feedback, failure: _failure, merged: _merged, ...rest } = node;
        return {
          ...rest,
          status: 'running',
          dispatchId: launch.dispatchId,
          placement: launch.placement,
          ...(worktreeId === undefined ? {} : { worktreeId }),
        };
      }),
    });
    const isolated = isolate && launch.placement === 'isolated';
    if (store.dispatches.get(launch.dispatchId) !== undefined) {
      // 崩溃前已经启动并落库：只补节点状态，不重复启动
      mutate(taskId, (workflow) =>
        pendingLaunch(workflow)
          ? finish(workflow, isolated ? launch.worktreeId : undefined)
          : undefined
      );
      return { ok: true };
    }
    // 先释放已结算节点的会话（线性部分：上一步空闲后释放，再在同一 worktree 起下一步）
    await releaseSettled(taskId);
    let task = activeTask(taskId);
    if (task === undefined || pendingLaunch(task.workflow) === undefined) return { ok: true };
    const step = workflowStep(task.workflow, launch.nodeId);
    if (step === undefined)
      return { ok: false, error: `workflow node ${launch.nodeId} does not exist` };

    let worktree: Worktree | undefined;
    if (isolate) {
      const integration = integrationOf(task.workflow);
      if (integration === undefined) {
        return { ok: false, error: 'the task worktree of this workflow was already cleaned up' };
      }
      if (!isolated) {
        worktree = integration;
      } else if (launch.worktreeId !== undefined && store.worktrees.get(launch.worktreeId)) {
        worktree = store.worktrees.get(launch.worktreeId);
      } else {
        const created = await git.create({
          repoPath,
          workspaceId: workspace.id,
          slug: nodeSlug(integration, task.title, launch.nodeId),
          baseRef: integration.branch,
          worktreesRoot: await deps.resolveWorktreesRoot(workspace),
        });
        if (!created.ok)
          return { ok: false, error: `could not create a worktree: ${created.error}` };
        worktree = created.worktree;
        const createdId = worktree.id;
        // 建好就落库（记录 + 意图上的 worktreeId），崩溃后复用或随 abandon 清理
        const inserted = store.worktrees.insert(worktree);
        const kept =
          inserted.ok &&
          mutate(taskId, (workflow) =>
            pendingLaunch(workflow)
              ? {
                  ...workflow,
                  launches: workflow.launches.map((entry) =>
                    entry.dispatchId === launch.dispatchId
                      ? { ...entry, worktreeId: createdId }
                      : entry
                  ),
                }
              : undefined
          );
        if (!kept) {
          if (inserted.ok) store.worktrees.delete(createdId);
          await git.remove({ repoPath, path: created.worktree.path, force: true });
          await git.deleteBranch({ repoPath, branch: created.worktree.branch, force: true });
          return { ok: true };
        }
      }
    }
    // 意图被撤掉（abandon 等）时，它建的节点 worktree 不再被任何状态引用：顺手删掉
    const dropped = async (): Promise<LaunchResult> => {
      if (isolated && worktree !== undefined) await removeNodeWorktree(worktree.id);
      return { ok: true };
    };
    task = activeTask(taskId);
    if (task === undefined || pendingLaunch(task.workflow) === undefined) return dropped();
    const node = workflowNodeState(task.workflow, launch.nodeId);
    const brief = renderWorkerBrief({
      title: task.title,
      spec: task.spec,
      dispatchId: launch.dispatchId,
      workflow: workflowBriefContext(task.workflow, launch.nodeId, node?.feedback),
    });
    const started = await startAttemptSession(
      { workspace, launcher, now },
      { ...task, roleId: step.roleId },
      // nodeId 让同一任务下并行节点的尝试可以同时未结算（store 按节点校验）
      { dispatchId: launch.dispatchId, worktree, brief, nodeId: launch.nodeId }
    );
    if (!started.ok) return { ok: false, error: started.error };
    // 必须紧跟在 launcher resolve 之后同步落库，中间不能有 await（同 host.start）：
    // worker 的 report_done / ask_coordinator 经 Dispatch.workerSessionId 找到这次尝试
    const current = activeTask(taskId);
    if (current === undefined || pendingLaunch(current.workflow) === undefined) {
      await dispose(started.dispatch.workerSessionId);
      return dropped();
    }
    const inserted = store.dispatches.insert(started.dispatch);
    if (!inserted.ok) {
      void dispose(started.dispatch.workerSessionId);
      return { ok: false, error: inserted.error };
    }
    const recorded = mutate(
      taskId,
      (workflow) => finish(workflow, isolated ? worktree?.id : undefined),
      { roleId: step.roleId }
    );
    if (!recorded) {
      store.dispatches.delete(started.dispatch.id);
      void dispose(started.dispatch.workerSessionId);
      return { ok: false, error: `could not record workflow node ${step.name}` };
    }
    return { ok: true, dispatch: started.dispatch };
  }

  /** 启动失败（非 strict）：节点记 failed，撤掉意图与已建的节点 worktree。 */
  async function failLaunch(taskId: string, launch: TaskWorkflowLaunch, error: string) {
    const task = workflowTask(taskId);
    const name = task ? (workflowStep(task.workflow, launch.nodeId)?.name ?? launch.nodeId) : '';
    log(`workflow task ${taskId}: could not start node ${launch.nodeId}: ${error}`);
    // 意图上的 worktreeId 可能是启动途中刚写的：按最新状态取
    const worktreeId =
      task?.workflow.launches.find((entry) => entry.dispatchId === launch.dispatchId)?.worktreeId ??
      launch.worktreeId;
    mutate(taskId, (workflow) => {
      if (!workflow.launches.some((entry) => entry.dispatchId === launch.dispatchId)) return;
      const without = {
        ...workflow,
        launches: workflow.launches.filter((entry) => entry.dispatchId !== launch.dispatchId),
      };
      return failWorkflowNode(
        without,
        launch.nodeId,
        `Could not start workflow node "${name}": ${error}`,
        now()
      );
    });
    if (launch.placement === 'isolated' && worktreeId !== task?.workflow.worktreeId) {
      await removeNodeWorktree(worktreeId);
    }
  }

  // ---- 合并 ----

  /** 隔离节点通过后：释放会话 → 检查未提交改动 → 合回集成 worktree（幂等）→ 清理节点 worktree 与分支。 */
  async function mergeNode(taskId: string, nodeId: string): Promise<void> {
    const before = activeTask(taskId);
    const node = before && workflowNodeState(before.workflow, nodeId);
    if (before === undefined || node === undefined || !isUnmerged(node)) return;
    await release(node.dispatchId);
    const task = activeTask(taskId);
    const current = task && workflowNodeState(task.workflow, nodeId);
    if (task === undefined || current === undefined || !isUnmerged(current)) return;
    // 集成 worktree 里有 worker 时绝不往里合并
    if (
      task.workflow.nodes.some(
        (entry) => entry.status === 'running' && entry.placement === 'integration'
      )
    ) {
      return;
    }
    const name = workflowStep(task.workflow, nodeId)?.name ?? nodeId;
    const failNode = (reason: string) =>
      mutate(taskId, (workflow) => {
        const fresh = workflowNodeState(workflow, nodeId);
        return fresh && isUnmerged(fresh)
          ? failWorkflowNode(workflow, nodeId, reason, now())
          : undefined;
      });
    const integration = integrationOf(task.workflow);
    const worktree =
      current.worktreeId === undefined ? undefined : store.worktrees.get(current.worktreeId);
    if (integration === undefined || worktree === undefined) {
      failNode(`Node "${name}" could not be merged: its worktree or the task worktree is gone.`);
      return;
    }
    const status = await git.status(worktree);
    if (!status.ok || status.status.dirty) {
      failNode(
        status.ok
          ? `Node "${name}" left uncommitted changes or untracked files in its worktree; only committed work is merged. Commit everything before reporting.`
          : `Node "${name}" could not be merged: ${status.error}`
      );
      return;
    }
    let merged = false;
    try {
      const ancestor = await exec(
        'git',
        ['merge-base', '--is-ancestor', `refs/heads/${worktree.branch}`, 'HEAD'],
        integration.path
      );
      merged = ancestor.code === 0;
    } catch {
      merged = false;
    }
    if (!merged) {
      const result = await git.merge({ repoPath: integration.path, branch: worktree.branch });
      if (!result.ok) {
        failNode(
          result.conflicts && result.conflicts.length > 0
            ? `Merging node "${name}" back into the task worktree conflicted; the merge was aborted. Conflicting files:\n${result.conflicts.map((file) => `- ${file}`).join('\n')}`
            : `Merging node "${name}" back into the task worktree failed: ${result.error}`
        );
        return;
      }
    }
    if (!mutate(taskId, (workflow) => markWorkflowNodeMerged(workflow, nodeId))) return;
    const problems = await removeNodeWorktree(worktree.id);
    if (problems) log(`workflow task ${taskId}: cleaning up node ${nodeId}: ${problems}`);
  }

  // ---- 结束 ----

  /**
   * 代表整个任务的 dispatch（review / merge / cleanup 用）：最后一次尝试就在集成 worktree（或普通目录）里时用它，
   * 否则补一条已结算的汇总 dispatch，指向集成 worktree。
   */
  function representative(
    task: WorkflowTask,
    outcome: 'succeeded' | 'failed'
  ): Dispatch | undefined {
    const attempts = store.dispatches.list((dispatch) => dispatch.taskId === task.id);
    const last = attempts.at(-1);
    if (!isolate) return last;
    const integration = integrationOf(task.workflow);
    if (last !== undefined && (integration === undefined || last.worktreeId === integration.id)) {
      return last;
    }
    if (integration === undefined) return last;
    const settledAt = now();
    const summary = task.workflow.nodes
      .map((node) => {
        const entry = [...task.workflow.history].reverse().find((item) => item.nodeId === node.id);
        const step = workflowStep(task.workflow, node.id);
        return `### ${step?.name ?? node.id} (${node.status})\n\n${entry?.summary || '(no summary)'}`;
      })
      .join('\n\n');
    const latestSettled = [...attempts].reverse().find((dispatch) => dispatch.settledAt);
    const dispatch: Dispatch = {
      id: newId('dispatch'),
      taskId: task.id,
      workerSessionId: latestSettled?.workerSessionId ?? last?.workerSessionId ?? '',
      worktreeId: integration.id,
      branch: integration.branch,
      startedAt: settledAt,
      settledAt,
      outcome,
      summary:
        summary.length <= WORKFLOW_SUMMARY_MAX * 4
          ? summary
          : `${summary.slice(0, WORKFLOW_SUMMARY_MAX * 4)}…`,
      filesModified: unionFiles(store, task.id),
    };
    const inserted = store.dispatches.insert(dispatch);
    return inserted.ok ? dispatch : last;
  }

  /** 任务结束：in-review / failed，投 worker_done（dispatch 指向集成 worktree）。 */
  function finish(taskId: string, outcome: 'succeeded' | 'failed', reason?: string): void {
    const task = activeTask(taskId);
    if (task === undefined) return;
    const dispatch = representative(task, outcome);
    const moved = store.tasks.update(taskId, {
      status: outcome === 'succeeded' ? 'in-review' : 'failed',
      workflow: { ...task.workflow, launches: [] },
    });
    if (!moved.ok) {
      log(`workflow task ${taskId}: could not record the result: ${moved.error}`);
      return;
    }
    const run = store.runs.get(task.runId);
    if (run === undefined) return;
    inbox.post({
      runId: run.id,
      ...(dispatch ? { dispatchId: dispatch.id } : {}),
      from: ENGINE_SENDER,
      to: run.coordinatorSessionId,
      type: 'worker_done',
      subject: outcome,
      body: workflowDoneBody(store, task, outcome, reason),
    });
  }

  // ---- 推进循环 ----

  /** 旧快照：运行中却没有 dispatch 的节点按最近一次尝试补上；集成 worktree 按第一次尝试补上。 */
  function repair(taskId: string): void {
    const task = workflowTask(taskId);
    if (task === undefined) return;
    const workflow = task.workflow;
    const orphan = workflow.nodes.find(
      (node) => node.status === 'running' && node.dispatchId === undefined
    );
    const attempts = store.dispatches.list((dispatch) => dispatch.taskId === taskId);
    const needsWorktree =
      isolate && workflow.worktreeId === undefined && attempts.some((entry) => entry.worktreeId);
    if (orphan === undefined && !needsWorktree) return;
    let next: TaskWorkflow = structuredClone(workflow);
    if (needsWorktree) {
      const first = attempts.find((entry) => store.worktrees.get(entry.worktreeId));
      if (first) next = { ...next, worktreeId: first.worktreeId };
    }
    if (orphan !== undefined) {
      // 带 nodeId 的尝试只归它自己的节点（并行节点各有各的）；旧快照没有 nodeId，按最近一次
      const last = attempts
        .filter((entry) => entry.nodeId === undefined || entry.nodeId === orphan.id)
        .at(-1);
      next = {
        ...next,
        nodes: next.nodes.map((node): TaskWorkflowNodeState => {
          if (node.id !== orphan.id) return node;
          if (last === undefined) return { id: node.id, status: 'waiting' };
          if (!isDispatchSettled(last)) return { ...node, dispatchId: last.id };
          return last.outcome === 'succeeded'
            ? { ...node, status: 'passed', dispatchId: last.id }
            : {
                ...node,
                status: 'failed',
                dispatchId: last.id,
                failure: last.summary ?? '(no summary)',
              };
        }),
      };
    }
    store.tasks.update(taskId, { workflow: next });
  }

  type PumpResult = { dispatches: Dispatch[]; error?: string };

  async function pump(taskId: string, strict: boolean): Promise<PumpResult> {
    const dispatches: Dispatch[] = [];
    repair(taskId);
    for (let steps = 0; steps < MAX_PUMP_STEPS; steps++) {
      const task = activeTask(taskId);
      if (task === undefined) return { dispatches };
      const workflow = task.workflow;

      // 1. 待启动意图（先落库的意图，或崩溃前没走完的）
      const launch = workflow.launches[0];
      if (launch !== undefined) {
        let result: LaunchResult;
        try {
          result = await runLaunch(taskId, launch);
        } catch (error) {
          result = fail(errorMessage(error));
        }
        if (result.ok) {
          if (result.dispatch) dispatches.push(result.dispatch);
          // 意图没被消费（并发改动）时不要原地打转
          const still = activeTask(taskId)?.workflow.launches[0];
          if (still?.dispatchId === launch.dispatchId) {
            mutate(taskId, (current) => ({
              ...current,
              launches: current.launches.filter((entry) => entry.dispatchId !== launch.dispatchId),
            }));
          }
          continue;
        }
        if (strict) return { dispatches, error: result.error };
        await failLaunch(taskId, launch, result.error);
        continue;
      }

      // 2. 通过的隔离节点串行合回集成 worktree
      const unmerged = workflow.nodes.find(isUnmerged);
      if (unmerged !== undefined) {
        const integrationBusy = workflow.nodes.some(
          (node) => node.status === 'running' && node.placement === 'integration'
        );
        if (integrationBusy) return { dispatches };
        await mergeNode(taskId, unmerged.id);
        const after = activeTask(taskId);
        const same = after && workflowNodeState(after.workflow, unmerged.id);
        if (same && isUnmerged(same)) return { dispatches };
        continue;
      }

      // 3. 调度
      const plan = planWorkflow(workflow, { isolate });
      if (plan.kind === 'wait') return { dispatches };
      if (plan.kind === 'done') {
        finish(taskId, plan.outcome);
        return { dispatches };
      }
      if (plan.kind === 'retreat') {
        // 失败节点的会话与隔离 worktree 不再需要：重置后它们会从集成 worktree 重新分出
        const failed = workflow.nodes.filter((node) => node.status === 'failed');
        for (const node of failed) await release(node.dispatchId);
        for (const node of failed) {
          if (node.placement === 'isolated') await removeNodeWorktree(node.worktreeId);
        }
        mutate(taskId, (current) => {
          const fresh = planWorkflow(current, { isolate });
          return fresh.kind === 'retreat' ? fresh.workflow : undefined;
        });
        continue;
      }
      // 先写意图再启动（崩溃恢复：意图里的 dispatch 已存在就不会重复启动）
      mutate(taskId, (current) => {
        const fresh = planWorkflow(current, { isolate });
        if (fresh.kind !== 'launch') return undefined;
        return withWorkflowLaunches(
          current,
          fresh.launches.map((entry) => ({
            nodeId: entry.nodeId,
            dispatchId: newId('dispatch'),
            placement: entry.placement,
          }))
        );
      });
    }
    log(`workflow task ${taskId}: stopped advancing after ${MAX_PUMP_STEPS} steps`);
    return { dispatches };
  }

  function advance(taskId: string): void {
    if (busy.has(taskId)) {
      again.add(taskId);
      return;
    }
    busy.add(taskId);
    void (async () => {
      try {
        do {
          again.delete(taskId);
          await pump(taskId, false);
        } while (again.has(taskId));
      } catch (error) {
        log(`workflow task ${taskId}: ${errorMessage(error)}`);
      } finally {
        busy.delete(taskId);
        again.delete(taskId);
      }
    })();
  }

  async function discardNodes(taskId: string): Promise<string> {
    const task = workflowTask(taskId);
    if (task === undefined) return '';
    const integration = task.workflow.worktreeId;
    const attempts = store.dispatches.list((dispatch) => dispatch.taskId === taskId);
    for (const dispatch of attempts) {
      if (released.has(dispatch.id)) continue;
      await dispose(dispatch.workerSessionId);
      released.add(dispatch.id);
    }
    const ids = new Set<string>([
      ...attempts.map((dispatch) => dispatch.worktreeId),
      ...task.workflow.nodes.flatMap((node) => (node.worktreeId ? [node.worktreeId] : [])),
      ...task.workflow.launches.flatMap((launch) => (launch.worktreeId ? [launch.worktreeId] : [])),
    ]);
    const problems: string[] = [];
    for (const id of ids) {
      if (id === '' || id === integration) continue;
      const problem = await removeNodeWorktree(id);
      if (problem) problems.push(problem);
    }
    return problems.join('; ');
  }

  return {
    advance,
    async start(taskId, rollback) {
      if (busy.has(taskId)) return fail(`task ${taskId} is already advancing its workflow`);
      busy.add(taskId);
      let result: PumpResult;
      try {
        try {
          result = await pump(taskId, true);
        } catch (error) {
          result = { dispatches: [], error: errorMessage(error) };
        }
        if (result.error !== undefined) {
          // 撤掉本次启动的一切：会话、dispatch、节点 worktree，然后由调用方还原任务
          for (const dispatch of result.dispatches) {
            await dispose(dispatch.workerSessionId);
          }
          const task = workflowTask(taskId);
          const created = new Set<string>([
            ...(task?.workflow.launches.flatMap((launch) =>
              launch.worktreeId ? [launch.worktreeId] : []
            ) ?? []),
            ...result.dispatches.map((dispatch) => dispatch.worktreeId),
          ]);
          for (const dispatch of result.dispatches) store.dispatches.delete(dispatch.id);
          for (const id of created) {
            if (id !== '' && id !== task?.workflow.worktreeId) await removeNodeWorktree(id);
          }
          rollback();
          return fail(result.error);
        }
        return { ok: true, dispatches: result.dispatches };
      } finally {
        busy.delete(taskId);
        if (again.has(taskId)) {
          again.delete(taskId);
          advance(taskId);
        }
      }
    },
    isAdvancing: (taskId) => busy.has(taskId),
    resume() {
      if (deps.canLaunch && !deps.canLaunch()) return;
      for (const task of store.tasks.list((entry) => entry.workflow !== undefined)) {
        if (task.status !== 'in-progress') {
          repair(task.id);
          continue;
        }
        advance(task.id);
      }
    },
    discardNodes,
  };
}
