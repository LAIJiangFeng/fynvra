import type { BriefWorkflowContext } from '../briefs/renderBrief';
import type {
  Task,
  TaskWorkflow,
  TaskWorkflowHistoryEntry,
  TaskWorkflowLaunch,
  TaskWorkflowNodeState,
  TaskWorkflowNodeStatus,
  TaskWorkflowPlacement,
} from '../types';
import { summarizeWorkflow, workflowAncestors, workflowDescendants } from './graph';
import type { Workflow, WorkflowStep } from './workflow';

/** Task.workflow.history 保留的条数 */
export const WORKFLOW_HISTORY_MAX = 30;
/** 历史里每条摘要的最大字数 */
export const WORKFLOW_SUMMARY_MAX = 2000;
/** 写进任务书的退回反馈的最大字数 */
export const WORKFLOW_FEEDBACK_MAX = 4000;
/** 每个工作流任务最多同时运行的节点数 */
export const WORKFLOW_MAX_PARALLEL = 4;
/** 任务书里列出的上游节点数 */
const BRIEF_HISTORY_MAX = 10;

function clip(text: string, max: number): string {
  const body = text.trim();
  return body.length <= max ? body : `${body.slice(0, max)}…`;
}

const waitingNode = (id: string, feedback?: string): TaskWorkflowNodeState => ({
  id,
  status: 'waiting',
  ...(feedback?.trim() ? { feedback: clip(feedback, WORKFLOW_FEEDBACK_MAX) } : {}),
});

/** 派发时把工作流定义快照进 Task：全部节点等待，回退次数为 0。 */
export function snapshotTaskWorkflow(workflow: Workflow): TaskWorkflow {
  return {
    id: workflow.id,
    name: workflow.name,
    steps: structuredClone(workflow.steps),
    maxRounds: workflow.maxRounds,
    rounds: 0,
    nodes: workflow.steps.map((step) => waitingNode(step.id)),
    launches: [],
    history: [],
  };
}

/** 节点定义。 */
export function workflowStep(workflow: TaskWorkflow, nodeId: string): WorkflowStep | undefined {
  return workflow.steps.find((step) => step.id === nodeId);
}

/** 节点运行状态。 */
export function workflowNodeState(
  workflow: TaskWorkflow,
  nodeId: string
): TaskWorkflowNodeState | undefined {
  return workflow.nodes.find((node) => node.id === nodeId);
}

/** 本轮绑定了该 dispatch 的节点（任意状态）。 */
export function workflowNodeOfDispatch(
  workflow: TaskWorkflow,
  dispatchId: string
): TaskWorkflowNodeState | undefined {
  return workflow.nodes.find((node) => node.dispatchId === dispatchId);
}

/** 正在运行的节点的 dispatch id。 */
export function workflowRunningDispatchIds(workflow: TaskWorkflow): string[] {
  return workflow.nodes.flatMap((node) =>
    node.status === 'running' && node.dispatchId !== undefined ? [node.dispatchId] : []
  );
}

/** 节点已通过、但还没合回集成 worktree。 */
export const isUnmerged = (node: TaskWorkflowNodeState): boolean =>
  node.status === 'passed' && node.merged === false;

/** 已通过且（隔离节点）已合回：下游可以开始。 */
const isDone = (node: TaskWorkflowNodeState | undefined): boolean =>
  node?.status === 'passed' && node.merged !== false;

function withNodes(
  workflow: TaskWorkflow,
  change: (node: TaskWorkflowNodeState) => TaskWorkflowNodeState
): TaskWorkflow {
  const copy = structuredClone(workflow);
  return { ...copy, nodes: copy.nodes.map(change) };
}

function pushHistory(workflow: TaskWorkflow, entry: TaskWorkflowHistoryEntry): TaskWorkflow {
  return { ...workflow, history: [...workflow.history, entry].slice(-WORKFLOW_HISTORY_MAX) };
}

/**
 * 节点 worker 的 report_done（纯函数）：绑定该 dispatch 的运行中节点记为 passed（隔离节点待合并）
 * 或 failed，并记一条历史。没有对应的运行中节点时返回 undefined。
 */
export function recordWorkflowNodeReport(
  workflow: TaskWorkflow,
  report: { dispatchId: string; outcome: 'succeeded' | 'failed'; summary: string; at: number }
): TaskWorkflow | undefined {
  const target = workflow.nodes.find(
    (node) => node.status === 'running' && node.dispatchId === report.dispatchId
  );
  if (target === undefined) return undefined;
  const summary = clip(report.summary, WORKFLOW_SUMMARY_MAX);
  const next = withNodes(workflow, (node) => {
    if (node.id !== target.id) return node;
    const { feedback: _feedback, failure: _failure, merged: _merged, ...rest } = node;
    return report.outcome === 'succeeded'
      ? { ...rest, status: 'passed', ...(node.placement === 'isolated' ? { merged: false } : {}) }
      : { ...rest, status: 'failed', failure: summary || '(no summary)' };
  });
  return pushHistory(next, {
    nodeId: target.id,
    dispatchId: report.dispatchId,
    outcome: report.outcome,
    summary,
    at: report.at,
  });
}

/** 节点记为失败（合并冲突、未提交改动、启动失败等），并记一条失败历史。 */
export function failWorkflowNode(
  workflow: TaskWorkflow,
  nodeId: string,
  reason: string,
  at: number
): TaskWorkflow {
  const current = workflowNodeState(workflow, nodeId);
  const failure = clip(reason, WORKFLOW_SUMMARY_MAX);
  const next = withNodes(workflow, (node) => {
    if (node.id !== nodeId) return node;
    const { feedback: _feedback, merged: _merged, ...rest } = node;
    return { ...rest, status: 'failed', failure };
  });
  return pushHistory(next, {
    nodeId,
    dispatchId: current?.dispatchId ?? '',
    outcome: 'failed',
    summary: failure,
    at,
  });
}

/** 隔离节点已合回集成 worktree。 */
export function markWorkflowNodeMerged(workflow: TaskWorkflow, nodeId: string): TaskWorkflow {
  return withNodes(workflow, (node) =>
    node.id === nodeId && isUnmerged(node) ? { ...node, merged: true } : node
  );
}

/** reject_work：整图从起点重跑。全部节点等待、反馈交给起点，rounds 归零，历史与集成 worktree 保留。 */
export function restartTaskWorkflow(workflow: TaskWorkflow, feedback: string): TaskWorkflow {
  const copy = structuredClone(workflow);
  return {
    ...copy,
    rounds: 0,
    launches: [],
    nodes: copy.steps.map((step) =>
      waitingNode(step.id, step.needs.length === 0 ? feedback : undefined)
    ),
  };
}

/** abandon：运行中的节点记为取消，撤掉待启动意图。 */
export function cancelTaskWorkflow(workflow: TaskWorkflow): TaskWorkflow {
  const next = withNodes(workflow, (node) =>
    node.status === 'running' ? { ...node, status: 'cancelled' } : node
  );
  return { ...next, launches: [] };
}

/** 是否还有节点在运行、待启动或待合并。 */
export function isWorkflowBusy(workflow: TaskWorkflow): boolean {
  return (
    workflow.launches.length > 0 ||
    workflow.nodes.some((node) => node.status === 'running' || isUnmerged(node))
  );
}

/** {@link planWorkflow} 的结论。 */
export type WorkflowPlan =
  /** 等运行中的节点结束（或合并完成） */
  | { kind: 'wait' }
  /** 启动这些节点（按拓扑序） */
  | { kind: 'launch'; launches: { nodeId: string; placement: TaskWorkflowPlacement }[] }
  /** 汇总失败后退回：新的推进状态（rounds + 1，目标及其后代重置为等待） */
  | { kind: 'retreat'; workflow: TaskWorkflow; target: string }
  /** 整个工作流结束 */
  | { kind: 'done'; outcome: 'succeeded' | 'failed' };

/**
 * 调度决定（纯函数）。`isolate` 为 false（普通目录）时一次只跑一个节点、都在工作区目录里。
 * - 有失败节点：等运行中 / 待启动 / 待合并的节点都结束后汇总。每个失败节点都有 onFail 且 rounds < maxRounds
 *   → 退回到这些目标里拓扑序最靠前的一个；否则整个工作流失败。
 * - 全部通过且已合并 → 成功。
 * - 否则启动可运行的节点（所有上游都通过并已合并），同时最多 {@link WORKFLOW_MAX_PARALLEL} 个；
 *   当前唯一可运行、且没有其他节点在运行的节点放在集成 worktree，其余各自隔离。
 */
export function planWorkflow(workflow: TaskWorkflow, options: { isolate: boolean }): WorkflowPlan {
  const { nodes, steps } = workflow;
  const running = nodes.filter((node) => node.status === 'running').length;
  const busy = running + workflow.launches.length;
  const unmerged = nodes.some(isUnmerged);
  const failed = nodes.filter((node) => node.status === 'failed');
  if (failed.length > 0) {
    if (busy > 0 || unmerged) return { kind: 'wait' };
    return aggregateFailures(workflow, failed);
  }
  if (nodes.every(isDone)) return { kind: 'done', outcome: 'succeeded' };
  const launching = new Set(workflow.launches.map((launch) => launch.nodeId));
  const ready = steps.filter((step) => {
    const node = workflowNodeState(workflow, step.id);
    if (node?.status !== 'waiting' || launching.has(step.id)) return false;
    return step.needs.every((need) => {
      const parent = workflowNodeState(workflow, need);
      return parent === undefined || isDone(parent);
    });
  });
  if (ready.length === 0) return { kind: 'wait' };
  if (!options.isolate) {
    const first = ready[0];
    return busy > 0 || unmerged || first === undefined
      ? { kind: 'wait' }
      : { kind: 'launch', launches: [{ nodeId: first.id, placement: 'integration' }] };
  }
  const capacity = WORKFLOW_MAX_PARALLEL - busy;
  if (capacity <= 0) return { kind: 'wait' };
  const sole = ready.length === 1 && busy === 0 && !unmerged;
  return {
    kind: 'launch',
    launches: ready.slice(0, capacity).map((step) => ({
      nodeId: step.id,
      placement: sole ? 'integration' : 'isolated',
    })),
  };
}

function aggregateFailures(workflow: TaskWorkflow, failed: TaskWorkflowNodeState[]): WorkflowPlan {
  const { steps } = workflow;
  const index = new Map(steps.map((step, position) => [step.id, position]));
  const targets = failed.map((node) => workflowStep(workflow, node.id)?.onFail);
  const retreat =
    workflow.rounds < workflow.maxRounds &&
    targets.every((target) => target !== undefined && index.has(target));
  if (!retreat) return { kind: 'done', outcome: 'failed' };
  // steps 按拓扑序存放：下标最小的就是最上游
  const target = (targets as string[]).reduce((best, id) =>
    (index.get(id) ?? 0) < (index.get(best) ?? 0) ? id : best
  );
  const message = (node: TaskWorkflowNodeState) =>
    `Node "${workflowStep(workflow, node.id)?.name ?? node.id}" reported problems and sent the work back:\n\n${node.failure ?? '(no summary)'}`;
  const targetScope = new Set([target, ...workflowDescendants(steps, target)]);
  const feedback = new Map<string, string>([[target, failed.map(message).join('\n\n---\n\n')]]);
  const reset = new Set(targetScope);
  for (const node of failed) {
    reset.add(node.id);
    for (const id of workflowDescendants(steps, node.id)) reset.add(id);
    // 不在退回目标之下的失败节点也要重跑，带上它自己的问题
    if (!targetScope.has(node.id)) feedback.set(node.id, message(node));
  }
  const next = withNodes(workflow, (node) =>
    reset.has(node.id) ? waitingNode(node.id, feedback.get(node.id)) : node
  );
  return {
    kind: 'retreat',
    target,
    workflow: { ...next, rounds: workflow.rounds + 1, launches: [] },
  };
}

/** 新的启动意图。 */
export function withWorkflowLaunches(
  workflow: TaskWorkflow,
  launches: readonly TaskWorkflowLaunch[]
): TaskWorkflow {
  return { ...structuredClone(workflow), launches: [...workflow.launches, ...launches] };
}

/** `名称 (角色)`。 */
export function describeWorkflowNode(workflow: TaskWorkflow, nodeId: string): string {
  const step = workflowStep(workflow, nodeId);
  return `${step?.name ?? nodeId} (${step?.roleId ?? '?'})`;
}

/** 图的文字摘要（W1），节点标签为 `名称 [角色]`。 */
export function summarizeTaskWorkflow(workflow: TaskWorkflow): string {
  return summarizeWorkflow(workflow.steps, (step) => `${step.name} [${step.roleId}]`);
}

/** list_workers 用的一行：`workflow <名称> · <摘要> · rounds r/max`。 */
export function workflowProgressLine(workflow: TaskWorkflow): string {
  return `workflow ${workflow.name} · ${summarizeTaskWorkflow(workflow)} · rounds ${workflow.rounds}/${workflow.maxRounds}`;
}

/** 节点状态的展示词：通过待合并的隔离节点显示为 `merging`。 */
export function workflowNodeLabel(node: TaskWorkflowNodeState): TaskWorkflowNodeStatus | 'merging' {
  return isUnmerged(node) ? 'merging' : node.status;
}

/** 每个节点一行（按拓扑序）：`<状态> · <名称> (<角色>)[ · dispatch <id>][ · own worktree]`。 */
export function describeWorkflowNodes(workflow: TaskWorkflow): string[] {
  const launching = new Map(workflow.launches.map((launch) => [launch.nodeId, launch]));
  return workflow.steps.map((step) => {
    const node = workflowNodeState(workflow, step.id);
    const launch = launching.get(step.id);
    const status = launch ? 'starting' : node ? workflowNodeLabel(node) : 'waiting';
    const dispatch = node?.dispatchId && !launch ? ` · dispatch ${node.dispatchId}` : '';
    const placement =
      (launch?.placement ?? node?.placement) === 'isolated' ? ' · own worktree' : '';
    return `${status} · ${step.name} (${step.roleId})${dispatch}${placement}`;
  });
}

/** 工作流历程（各节点结果与摘要），用于给主 agent 的 worker_done 正文。 */
export function describeWorkflowHistory(workflow: TaskWorkflow): string {
  if (workflow.history.length === 0) return '(no node has reported yet)';
  return workflow.history
    .map((entry) => {
      const summary = entry.summary.trim() || '(no summary)';
      const dispatch = entry.dispatchId ? ` · dispatch ${entry.dispatchId}` : '';
      return `### Node ${describeWorkflowNode(workflow, entry.nodeId)} · ${entry.outcome}${dispatch}\n\n${summary}`;
    })
    .join('\n\n');
}

/** 节点任务书的工作流上下文：已完成上游节点的最新摘要 + 反馈。 */
export function workflowBriefContext(
  workflow: TaskWorkflow,
  nodeId: string,
  feedback?: string
): BriefWorkflowContext {
  const index = workflow.steps.findIndex((step) => step.id === nodeId);
  const step = workflow.steps[index];
  const ancestors = workflowAncestors(workflow.steps, nodeId);
  const latest = new Map<string, TaskWorkflowHistoryEntry>();
  for (const entry of workflow.history) {
    if (ancestors.has(entry.nodeId)) latest.set(entry.nodeId, entry);
  }
  const previous = [...latest.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-BRIEF_HISTORY_MAX)
    .map((entry) => ({
      stepName: workflowStep(workflow, entry.nodeId)?.name ?? entry.nodeId,
      outcome: entry.outcome,
      summary: entry.summary,
    }));
  return {
    name: workflow.name,
    stepIndex: Math.max(index, 0),
    stepCount: workflow.steps.length,
    stepName: step?.name ?? nodeId,
    instructions: step?.instructions ?? '',
    previous,
    ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
  };
}

// ---- 快照读入 ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

const NODE_STATUSES: readonly string[] = ['waiting', 'running', 'passed', 'failed', 'cancelled'];
const isPlacement = (value: unknown) => value === 'integration' || value === 'isolated';

function isStepSnapshot(value: unknown): value is WorkflowStep {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.roleId === 'string' &&
    typeof value.instructions === 'string' &&
    (value.needs === undefined ||
      (Array.isArray(value.needs) && value.needs.every((need) => typeof need === 'string'))) &&
    isOptionalString(value.onFail)
  );
}

/** 旧快照（W1 之前）的步骤没有 needs：全部缺省时按列表顺序补成线性链，否则缺的补 []。就地修改。 */
function fillLegacyNeeds(steps: Record<string, unknown>[]): void {
  const legacy = steps.every((step) => step.needs === undefined);
  steps.forEach((step, index) => {
    if (step.needs !== undefined) return;
    const previous = steps[index - 1];
    step.needs = legacy && previous ? [previous.id] : [];
  });
}

function isHistoryShape(value: unknown, legacy: boolean): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (legacy ? isIndex(value.step) : typeof value.nodeId === 'string') &&
    typeof value.dispatchId === 'string' &&
    (value.outcome === 'succeeded' || value.outcome === 'failed') &&
    typeof value.summary === 'string' &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  );
}

function isNodeState(value: unknown, id: string | undefined): value is TaskWorkflowNodeState {
  return (
    isRecord(value) &&
    value.id === id &&
    NODE_STATUSES.includes(value.status as string) &&
    isOptionalString(value.dispatchId) &&
    (value.placement === undefined || isPlacement(value.placement)) &&
    isOptionalString(value.worktreeId) &&
    (value.merged === undefined || typeof value.merged === 'boolean') &&
    isOptionalString(value.feedback) &&
    isOptionalString(value.failure)
  );
}

function isLaunch(value: unknown, ids: Set<string>): value is TaskWorkflowLaunch {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    ids.has(value.nodeId) &&
    typeof value.dispatchId === 'string' &&
    isPlacement(value.placement) &&
    isOptionalString(value.worktreeId)
  );
}

/**
 * 旧快照（W2 之前：`step` 下标 + 单个 `pending`）就地转成按节点记录的状态：
 * - 有 pending：它之前的节点通过，它与之后的节点等待，pending 的反馈交给它；
 * - 没有 pending：当前步之前的节点通过，当前步记为运行中（dispatch 由引擎在加载时按最近一次尝试补上），之后的等待。
 * 历史条目的下标换成节点 id。
 */
function convertLegacy(value: Record<string, unknown>, steps: WorkflowStep[]): void {
  const step = value.step as number;
  const pending = value.pending as { step: number; feedback?: string } | undefined;
  const nodes = steps.map((entry, index): TaskWorkflowNodeState => {
    if (pending !== undefined) {
      if (index < pending.step) return { id: entry.id, status: 'passed', placement: 'integration' };
      return waitingNode(entry.id, index === pending.step ? pending.feedback : undefined);
    }
    if (index < step) return { id: entry.id, status: 'passed', placement: 'integration' };
    if (index === step) return { id: entry.id, status: 'running', placement: 'integration' };
    return waitingNode(entry.id);
  });
  value.history = (value.history as Record<string, unknown>[]).flatMap((entry) => {
    const id = steps[entry.step as number]?.id;
    if (id === undefined) return [];
    const { step: _step, ...rest } = entry;
    return [{ ...rest, nodeId: id }];
  });
  value.nodes = nodes;
  value.launches = [];
  delete value.step;
  delete value.pending;
}

/**
 * 快照读入时的 Task.workflow 守卫。通过时就地补齐旧快照：步骤缺的 needs（见 {@link fillLegacyNeeds}），
 * 以及 W2 之前按下标记录的推进状态（见 {@link convertLegacy}），让读出的值符合 {@link TaskWorkflow}。
 */
export function isTaskWorkflow(value: unknown): value is TaskWorkflow {
  if (!isRecord(value)) return false;
  const { steps, history } = value;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(steps) ||
    steps.length === 0 ||
    !steps.every(isStepSnapshot) ||
    !isIndex(value.maxRounds) ||
    !isIndex(value.rounds) ||
    !Array.isArray(history)
  ) {
    return false;
  }
  const legacy = value.nodes === undefined;
  if (!history.every((entry) => isHistoryShape(entry, legacy))) return false;
  if (legacy) {
    const { pending } = value;
    if (!isIndex(value.step) || value.step >= steps.length) return false;
    const pendingOk =
      pending === undefined ||
      (isRecord(pending) &&
        isIndex(pending.step) &&
        pending.step < steps.length &&
        isOptionalString(pending.feedback));
    if (!pendingOk) return false;
    fillLegacyNeeds(steps as unknown as Record<string, unknown>[]);
    convertLegacy(value, steps);
    return true;
  }
  const ids = new Set(steps.map((step) => step.id));
  const { nodes, launches } = value;
  if (
    !Array.isArray(nodes) ||
    nodes.length !== steps.length ||
    !nodes.every((node, index) => isNodeState(node, steps[index]?.id)) ||
    !Array.isArray(launches) ||
    !launches.every((launch) => isLaunch(launch, ids)) ||
    !isOptionalString(value.worktreeId)
  ) {
    return false;
  }
  fillLegacyNeeds(steps as unknown as Record<string, unknown>[]);
  return true;
}

/** 任务是否按工作流执行。 */
export function isWorkflowTask(task: Task): task is Task & { workflow: TaskWorkflow } {
  return task.workflow !== undefined;
}
