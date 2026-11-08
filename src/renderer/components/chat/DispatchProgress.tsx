import {
  type Dispatch,
  type Task,
  type TaskStatus,
  type TaskWorkflow,
  type TaskWorkflowNodeStatus,
  type WorkflowStep,
  workflowLevels,
} from '@fynvra/core';
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { workflowNodeStatuses } from '@/components/orchestration/common';
import {
  formatClock,
  formatDuration,
  oneLine,
  TASK_STATUS_TONE,
} from '@/components/orchestration/format';
import { useNow } from '@/components/orchestration/hooks';
import { Badge } from '@/components/ui/badge';
import { WorkflowGraph } from '@/components/workflows/WorkflowGraph';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { dispatchesOf, useOrchestrationStore } from '@/stores/orchestration';
import { useRolesStore } from '@/stores/roles';
import { useSessionsStore } from '@/stores/sessions';

/** 与输入框里 `/工作流` 标签同色 */
export const WORKFLOW_TAG_CLASS = 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300';

// --- 订阅 -------------------------------------------------------------------------------------

/** 对话卡片共用的工作区订阅：同一工作区只 watch 一次，最后一张卡片卸载一会儿后才退订。 */
const RELEASE_DELAY_MS = 10_000;
const workspaceHolds = new Map<
  string,
  { count: number; release: () => void; timer: ReturnType<typeof setTimeout> | null }
>();

function holdWorkspace(workspaceId: string): () => void {
  let hold = workspaceHolds.get(workspaceId);
  if (!hold) {
    hold = {
      count: 0,
      release: useOrchestrationStore.getState().watchWorkspace(workspaceId),
      timer: null,
    };
    workspaceHolds.set(workspaceId, hold);
  }
  const current = hold;
  current.count += 1;
  if (current.timer !== null) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.count -= 1;
    if (current.count > 0) return;
    current.timer = setTimeout(() => {
      if (current.count > 0) return;
      current.release();
      workspaceHolds.delete(workspaceId);
    }, RELEASE_DELAY_MS);
  };
}

/**
 * dispatch_task 卡片对应的任务（按 id 只订阅这一条）。挂载时让当前工作区的快照保持订阅，
 * 这样右侧面板关着时也能实时更新。task 不在快照里（旧 run、已清理、还没拉到）时为 undefined。
 */
export function useDispatchedTask(taskId: string | undefined): {
  workspaceId: string | null;
  task: Task | undefined;
} {
  const workspaceId = useSessionsStore((state) => state.workspaceId);
  const enabled = taskId !== undefined;
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    return holdWorkspace(workspaceId);
  }, [enabled, workspaceId]);
  const task = useOrchestrationStore((state) =>
    taskId && workspaceId
      ? state.snapshots[workspaceId]?.view?.tasks.find((candidate) => candidate.id === taskId)
      : undefined
  );
  return { workspaceId, task };
}

// --- 徽标 -------------------------------------------------------------------------------------

/** 任务状态徽标：工作流任务的已完成 / 已放弃显示为「已完成 / 已取消」，普通任务为「已合并 / 已放弃」。 */
export function DispatchStatusBadge({
  status,
  workflow,
}: {
  status: TaskStatus;
  workflow: boolean;
}) {
  const t = useT();
  const tone = TASK_STATUS_TONE[status] ?? TASK_STATUS_TONE.todo;
  return (
    <Badge className={cn('shrink-0 border-transparent', tone.badge)}>
      {t(`tools.${workflow ? 'workflowStatus' : 'taskStatus'}.${status}`)}
    </Badge>
  );
}

/** 工作流任务标题行上的进度：「已完成 2/5」，有退回时加「第 N 轮」。 */
export function WorkflowProgressText({ workflow }: { workflow: TaskWorkflow }) {
  const t = useT();
  const statuses = useMemo(() => workflowNodeStatuses(workflow), [workflow]);
  const values = Object.values(statuses);
  const done = values.filter((status) => status === 'passed').length;
  const rounds = Number.isFinite(workflow.rounds) ? workflow.rounds : 0;
  return (
    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
      {t('tools.workflowDone', { done, total: values.length })}
      {rounds > 0 && ` · ${t('tools.workflowRound', { round: rounds + 1 })}`}
    </span>
  );
}

// --- 进度区 -----------------------------------------------------------------------------------

interface NodeRow {
  step: WorkflowStep;
  status: TaskWorkflowNodeStatus;
  /** 上游节点名（等待时显示） */
  upstream: string[];
  /** 节点最新一次尝试 */
  dispatch: Dispatch | undefined;
  /** 通过：最新一轮总结；失败：失败原因或反馈 */
  text: string;
  /** 结算时间 */
  settledAt: number | undefined;
  files: string[];
}

const NODE_ICON: Record<TaskWorkflowNodeStatus, { icon: LucideIcon; className: string }> = {
  waiting: { icon: CircleDashed, className: 'text-muted-foreground' },
  running: { icon: LoaderCircle, className: 'animate-spin text-sky-600 dark:text-sky-400' },
  passed: { icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-400' },
  failed: { icon: CircleX, className: 'text-destructive' },
  cancelled: { icon: CircleSlash, className: 'text-muted-foreground' },
};

const NO_DISPATCHES: Dispatch[] = [];

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

/** 旧快照可能缺字段：needs 缺失时按顺序视为一条直线。 */
function normalizedSteps(workflow: TaskWorkflow): WorkflowStep[] {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  return steps.map((step, index) => {
    if (Array.isArray(step.needs)) return step;
    const previous = steps[index - 1];
    return { ...step, needs: previous ? [previous.id] : [] };
  });
}

/** 按拓扑分层的节点行；同层的节点可以并行。 */
function buildRows(
  workflow: TaskWorkflow,
  steps: readonly WorkflowStep[],
  statuses: Record<string, TaskWorkflowNodeStatus>,
  dispatches: readonly Dispatch[]
): NodeRow[][] {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const history = Array.isArray(workflow.history) ? workflow.history : [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.id, dispatch]));
  const levels = workflowLevels(steps) ?? steps.map((step) => [step.id]);
  return levels
    .map((level) =>
      level.flatMap((id): NodeRow[] => {
        const step = byId.get(id);
        if (!step) return [];
        const status = statuses[id] ?? 'waiting';
        const node = nodes.find((candidate) => candidate?.id === id);
        const entry = history.findLast((candidate) => candidate?.nodeId === id);
        const dispatchId =
          node?.dispatchId && dispatchById.has(node.dispatchId)
            ? node.dispatchId
            : entry?.dispatchId;
        const dispatch = dispatchId ? dispatchById.get(dispatchId) : undefined;
        let text = '';
        if (status === 'passed') text = entry?.summary || dispatch?.summary || '';
        else if (status === 'failed')
          text = node?.failure || node?.feedback || entry?.summary || dispatch?.summary || '';
        return [
          {
            step,
            status,
            upstream: step.needs.map((need) => byId.get(need)?.name.trim() || need).filter(Boolean),
            dispatch,
            text,
            settledAt:
              status === 'passed' || status === 'failed'
                ? (dispatch?.settledAt ?? entry?.at)
                : undefined,
            files:
              status === 'passed' || status === 'failed'
                ? Array.isArray(dispatch?.filesModified)
                  ? dispatch.filesModified
                  : []
                : [],
          },
        ];
      })
    )
    .filter((level) => level.length > 0);
}

/**
 * 工作流任务的实时进度：只读小流程图 + 按拓扑分层的节点列表。点击节点在右侧任务抽屉里打开
 * 该节点最新一次尝试的输出。只在卡片展开时挂载。
 */
export function WorkflowTaskProgress({
  workspaceId,
  task,
  workflow,
  onOpenNode,
}: {
  workspaceId: string;
  task: Task;
  workflow: TaskWorkflow;
  /** 在任务抽屉里打开节点最新一次尝试的输出 */
  onOpenNode: (nodeId: string) => void;
}) {
  const t = useT();
  const dispatches = useOrchestrationStore(
    useShallow((state) => {
      const view = state.snapshots[workspaceId]?.view ?? null;
      return view ? dispatchesOf(view, task.id) : NO_DISPATCHES;
    })
  );
  const roles = useRolesStore((state) => state.roles);
  const roleNames = useMemo(
    () => Object.fromEntries(roles.map((role) => [role.id, role.name])),
    [roles]
  );
  const steps = useMemo(() => normalizedSteps(workflow), [workflow]);
  const statuses = useMemo(() => workflowNodeStatuses(workflow), [workflow]);
  const levels = useMemo(
    () => buildRows(workflow, steps, statuses, dispatches),
    [workflow, steps, statuses, dispatches]
  );
  const running = levels.some((level) => level.some((row) => row.status === 'running'));
  const now = useNow(1_000, running);

  if (steps.length === 0) return null;
  const openNode = onOpenNode;

  return (
    <div className="space-y-2">
      <div className="h-44 overflow-hidden rounded-md border bg-card">
        <WorkflowGraph
          steps={steps}
          roleNames={roleNames}
          statuses={statuses}
          onNodeClick={openNode}
        />
      </div>
      <ol className="space-y-1" aria-label={t('tools.workflowNodes')}>
        {levels.map((level) => (
          <li key={level.map((row) => row.step.id).join('|')}>
            {level.length > 1 ? (
              <div className="rounded-md border border-dashed px-1 pt-0.5 pb-1">
                <div className="px-1.5 text-[10px] text-muted-foreground">
                  {t('tools.workflowParallel')}
                </div>
                <ul className="space-y-0.5">
                  {level.map((row) => (
                    <li key={row.step.id}>
                      <NodeLine
                        row={row}
                        roleName={roleNames[row.step.roleId] ?? row.step.roleId}
                        now={now}
                        onOpen={openNode}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              level.map((row) => (
                <NodeLine
                  key={row.step.id}
                  row={row}
                  roleName={roleNames[row.step.roleId] ?? row.step.roleId}
                  now={now}
                  onOpen={openNode}
                />
              ))
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const FILES_PREVIEW = 8;

function NodeLine({
  row,
  roleName,
  now,
  onOpen,
}: {
  row: NodeRow;
  roleName: string;
  now: number;
  onOpen: (nodeId: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { icon: Icon, className } = NODE_ICON[row.status];
  const name = row.step.name.trim() || t('settings.workflows.graph.untitled');

  let line: string;
  if (row.status === 'passed') line = firstLine(row.text) || t('tools.nodeNoSummary');
  else if (row.status === 'failed') line = firstLine(row.text) || t('tools.nodeFailed');
  else if (row.status === 'running') line = t('tools.nodeRunning');
  else if (row.status === 'cancelled') line = t('tools.nodeCancelled');
  else
    line =
      row.upstream.length > 0
        ? t('tools.nodeWaitingFor', {
            nodes: row.upstream.join(t('orchestration.workflow.separator')),
          })
        : t('tools.nodeWaiting');

  let time = '';
  if (row.status === 'running' && row.dispatch && row.dispatch.settledAt === undefined) {
    time = t('tools.nodeElapsed', { duration: formatDuration(now - row.dispatch.startedAt, t) });
  } else if (row.settledAt !== undefined) {
    time = formatClock(row.settledAt, now);
  }

  const expandable = row.text.trim() !== '' || row.files.length > 0;

  return (
    <div className="rounded hover:bg-accent/50">
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 rounded px-1.5 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          title={t('tools.openNode')}
          onClick={() => onOpen(row.step.id)}
        >
          <Icon
            aria-label={t(`settings.workflows.graph.status.${row.status}`)}
            className={cn('mt-0.5 size-3.5 shrink-0', className)}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="truncate font-medium">{name}</span>
              <span className="shrink-0 text-muted-foreground">{roleName}</span>
              {time && (
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{time}</span>
              )}
            </span>
            <span
              className={cn(
                'block truncate text-muted-foreground text-xs',
                row.status === 'failed' && 'text-destructive'
              )}
            >
              {oneLine(line, 200)}
            </span>
          </span>
        </button>
        {expandable && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'tools.nodeCollapse' : 'tools.nodeExpand')}
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
            />
          </button>
        )}
      </div>
      {expanded && expandable && (
        <div className="space-y-1.5 px-7 pb-1.5 text-xs">
          {row.text.trim() !== '' && (
            <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
              {row.text.trim()}
            </p>
          )}
          {row.files.length > 0 && (
            <div className="space-y-0.5">
              <div className="font-medium text-muted-foreground">
                {t('tools.filesChanged', { count: row.files.length })}
              </div>
              <ul className="space-y-0.5 font-mono">
                {row.files.slice(0, FILES_PREVIEW).map((file) => (
                  <li key={file} className="truncate" title={file}>
                    {file}
                  </li>
                ))}
                {row.files.length > FILES_PREVIEW && (
                  <li className="text-muted-foreground">
                    {t('tools.moreFiles', { count: row.files.length })}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
