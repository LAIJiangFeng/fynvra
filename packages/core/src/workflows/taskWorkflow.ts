import type { BriefWorkflowContext } from '../briefs/renderBrief';
import type { Task, TaskWorkflow, TaskWorkflowHistoryEntry } from '../types';
import type { Workflow, WorkflowStep } from './workflow';

/** Task.workflow.history 保留的条数 */
export const WORKFLOW_HISTORY_MAX = 30;
/** 历史里每条摘要的最大字数 */
export const WORKFLOW_SUMMARY_MAX = 2000;
/** 写进任务书的退回反馈的最大字数 */
export const WORKFLOW_FEEDBACK_MAX = 4000;
/** 任务书里列出的之前步骤数 */
const BRIEF_HISTORY_MAX = 10;

function clip(text: string, max: number): string {
  const body = text.trim();
  return body.length <= max ? body : `${body.slice(0, max)}…`;
}

/** 派发时把工作流定义快照进 Task：从第一步开始，回退次数为 0。 */
export function snapshotTaskWorkflow(workflow: Workflow): TaskWorkflow {
  return {
    id: workflow.id,
    name: workflow.name,
    steps: structuredClone(workflow.steps),
    maxRounds: workflow.maxRounds,
    step: 0,
    rounds: 0,
    history: [],
  };
}

/** 去掉 `pending` 的副本（不留 undefined 键）。 */
export function withoutPending(workflow: TaskWorkflow): TaskWorkflow {
  const { pending: _pending, ...rest } = workflow;
  return structuredClone(rest);
}

/** {@link recordWorkflowReport} 的结果：`pending` 有值表示要启动下一步，否则整个工作流到此结束。 */
export interface WorkflowReportDecision {
  workflow: TaskWorkflow;
  /** 结束时整个任务的结果；继续推进时为 undefined */
  final?: 'succeeded' | 'failed';
}

/**
 * 当前步骤报告之后的推进决定（纯函数）：记一条历史，然后
 * - succeeded 且不是最后一步 → pending 下一步；
 * - failed 且有 onFail、rounds < maxRounds → rounds + 1，pending onFail 指向的步骤，失败摘要作为反馈；
 * - 其余 → 结束（最后一步 succeeded 为 succeeded，否则 failed）。
 */
export function recordWorkflowReport(
  workflow: TaskWorkflow,
  report: { dispatchId: string; outcome: 'succeeded' | 'failed'; summary: string; at: number }
): WorkflowReportDecision {
  const entry: TaskWorkflowHistoryEntry = {
    step: workflow.step,
    dispatchId: report.dispatchId,
    outcome: report.outcome,
    summary: clip(report.summary, WORKFLOW_SUMMARY_MAX),
    at: report.at,
  };
  const history = [...workflow.history, entry].slice(-WORKFLOW_HISTORY_MAX);
  const base: TaskWorkflow = { ...withoutPending(workflow), history };
  const current = workflow.steps[workflow.step];
  if (report.outcome === 'succeeded') {
    if (workflow.step + 1 < workflow.steps.length) {
      return { workflow: { ...base, pending: { step: workflow.step + 1 } } };
    }
    return { workflow: base, final: 'succeeded' };
  }
  const target =
    current?.onFail === undefined
      ? -1
      : workflow.steps.findIndex((step) => step.id === current.onFail);
  if (target >= 0 && workflow.rounds < workflow.maxRounds) {
    const feedback = clip(
      `Step "${current?.name ?? workflow.step + 1}" reported problems and sent the work back:\n\n${report.summary}`,
      WORKFLOW_FEEDBACK_MAX
    );
    return {
      workflow: { ...base, rounds: workflow.rounds + 1, pending: { step: target, feedback } },
    };
  }
  return { workflow: base, final: 'failed' };
}

/** 第 index 步的显示：`k/n 名称 (角色)`。 */
export function describeWorkflowStep(workflow: TaskWorkflow, index: number): string {
  const step: WorkflowStep | undefined = workflow.steps[index];
  return `${index + 1}/${workflow.steps.length} ${step?.name ?? '?'} (${step?.roleId ?? '?'})`;
}

/** list_workers 用的一行：`workflow <名称> · step k/n <步骤名> (<角色>) · rounds r/max`。 */
export function workflowProgressLine(workflow: TaskWorkflow): string {
  return `workflow ${workflow.name} · step ${describeWorkflowStep(workflow, workflow.step)} · rounds ${workflow.rounds}/${workflow.maxRounds}`;
}

/** 工作流历程（各步结果与摘要），用于给主 agent 的 worker_done 正文。 */
export function describeWorkflowHistory(workflow: TaskWorkflow): string {
  if (workflow.history.length === 0) return '(no step has reported yet)';
  return workflow.history
    .map((entry) => {
      const summary = entry.summary.trim() || '(no summary)';
      return `### Step ${describeWorkflowStep(workflow, entry.step)} · ${entry.outcome} · dispatch ${entry.dispatchId}\n\n${summary}`;
    })
    .join('\n\n');
}

/** 第 index 步任务书的工作流上下文。 */
export function workflowBriefContext(
  workflow: TaskWorkflow,
  index: number,
  feedback?: string
): BriefWorkflowContext {
  const step = workflow.steps[index];
  return {
    name: workflow.name,
    stepIndex: index,
    stepCount: workflow.steps.length,
    stepName: step?.name ?? `${index + 1}`,
    instructions: step?.instructions ?? '',
    previous: workflow.history.slice(-BRIEF_HISTORY_MAX).map((entry) => ({
      stepName: workflow.steps[entry.step]?.name ?? `${entry.step + 1}`,
      outcome: entry.outcome,
      summary: entry.summary,
    })),
    ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function isStepSnapshot(value: unknown): value is WorkflowStep {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.roleId === 'string' &&
    typeof value.instructions === 'string' &&
    (value.onFail === undefined || typeof value.onFail === 'string')
  );
}

function isHistoryEntry(value: unknown): value is TaskWorkflowHistoryEntry {
  return (
    isRecord(value) &&
    isIndex(value.step) &&
    typeof value.dispatchId === 'string' &&
    (value.outcome === 'succeeded' || value.outcome === 'failed') &&
    typeof value.summary === 'string' &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  );
}

/** 快照读入时的 Task.workflow 守卫：步骤下标必须落在步骤范围内。 */
export function isTaskWorkflow(value: unknown): value is TaskWorkflow {
  if (!isRecord(value)) return false;
  const { steps, history, pending } = value;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(steps) ||
    steps.length === 0 ||
    !steps.every(isStepSnapshot) ||
    !isIndex(value.maxRounds) ||
    !isIndex(value.step) ||
    value.step >= steps.length ||
    !isIndex(value.rounds) ||
    !Array.isArray(history) ||
    !history.every(isHistoryEntry)
  ) {
    return false;
  }
  if (pending === undefined) return true;
  return (
    isRecord(pending) &&
    isIndex(pending.step) &&
    pending.step < steps.length &&
    (pending.feedback === undefined || typeof pending.feedback === 'string')
  );
}

/** 任务是否按工作流执行。 */
export function isWorkflowTask(task: Task): task is Task & { workflow: TaskWorkflow } {
  return task.workflow !== undefined;
}
