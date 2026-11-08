import type { Dispatch, TaskStatus, TaskWorkflow, TaskWorkflowNodeStatus } from '@fynvra/core';
import { Bot, Loader2, type LucideIcon, Workflow } from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useRolesStore } from '@/stores/roles';
import { TASK_STATUS_TONE, taskStatusLabel } from './format';

/** 面板里的空态 / 加载 / 出错提示，居中显示。 */
export function PanelMessage({
  icon: Icon,
  title,
  description,
  spin = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  spin?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon className={cn('size-7 text-muted-foreground/60', spin && 'animate-spin')} />
      <p className="font-medium text-sm">{title}</p>
      {description && (
        <p className="max-w-64 text-balance text-muted-foreground text-xs">{description}</p>
      )}
      {children && <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

export function StatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        TASK_STATUS_TONE[status].dot,
        className
      )}
    />
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const t = useT();
  return (
    <Badge className={cn('border-transparent', TASK_STATUS_TONE[status].badge)}>
      {taskStatusLabel(status, t)}
    </Badge>
  );
}

/** 角色徽标：有对应角色时显示角色名，否则显示 id（角色可能已被删除）。 */
export function RoleBadge({ roleId }: { roleId: string }) {
  const name = useRolesStore((state) => state.roles.find((role) => role.id === roleId)?.name);
  const t = useT();
  return (
    <Badge
      variant="outline"
      className="max-w-32"
      title={t('sessions.roleHint', { name: name ?? roleId })}
    >
      <Bot />
      <span className="truncate">{name ?? roleId}</span>
    </Badge>
  );
}

const NODE_STATUSES: readonly TaskWorkflowNodeStatus[] = [
  'waiting',
  'running',
  'passed',
  'failed',
  'cancelled',
];

/** 各节点的运行状态（按 step id）；旧快照缺少或识别不了的状态按「等待」。 */
export function workflowNodeStatuses(
  workflow: TaskWorkflow
): Record<string, TaskWorkflowNodeStatus> {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const statuses: Record<string, TaskWorkflowNodeStatus> = {};
  for (const step of steps) statuses[step.id] = 'waiting';
  for (const node of nodes) {
    if (node && node.id in statuses && NODE_STATUSES.includes(node.status)) {
      statuses[node.id] = node.status;
    }
  }
  return statuses;
}

/** 节点当前的尝试，没有时取历史里最近一次；只认本任务已存在的尝试（与流程图点节点同义）。 */
export function workflowNodeDispatchId(
  workflow: TaskWorkflow,
  dispatches: readonly Dispatch[],
  nodeId: string
): string | undefined {
  const known = new Set(dispatches.map((dispatch) => dispatch.id));
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const history = Array.isArray(workflow.history) ? workflow.history : [];
  const current = nodes.find((node) => node?.id === nodeId)?.dispatchId;
  if (current && known.has(current)) return current;
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry?.nodeId === nodeId && known.has(entry.dispatchId)) return entry.dispatchId;
  }
  return undefined;
}

/** 整个工作流的状态：有节点运行 / 待启动即运行中，其次失败、全部通过、取消，否则等待。 */
export function workflowOverallStatus(workflow: TaskWorkflow): TaskWorkflowNodeStatus {
  const values = Object.values(workflowNodeStatuses(workflow));
  const launches = Array.isArray(workflow.launches) ? workflow.launches : [];
  if (values.includes('running') || launches.length > 0) return 'running';
  if (values.includes('failed')) return 'failed';
  if (values.length > 0 && values.every((status) => status === 'passed')) return 'passed';
  if (values.includes('cancelled')) return 'cancelled';
  return 'waiting';
}

const DOT_TONE: Record<TaskWorkflowNodeStatus, string> = {
  waiting: 'bg-muted-foreground/30',
  running: 'bg-sky-500 animate-pulse',
  passed: 'bg-emerald-500',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/60',
};

/** 任务卡片用的紧凑节点状态点（按 steps 顺序，悬停显示节点名与状态）。 */
export function WorkflowNodeDots({
  workflow,
  className,
}: {
  workflow: TaskWorkflow;
  className?: string;
}) {
  const t = useT();
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return null;
  const statuses = workflowNodeStatuses(workflow);
  return (
    <span aria-hidden className={cn('flex flex-wrap items-center gap-1', className)}>
      {steps.map((step) => {
        const status = statuses[step.id] ?? 'waiting';
        return (
          <span
            key={step.id}
            title={`${step.name} · ${t(`settings.workflows.graph.status.${status}`)}`}
            className={cn('size-1.5 shrink-0 rounded-full', DOT_TONE[status])}
          />
        );
      })}
    </span>
  );
}

/** 工作流任务的进度：运行中的节点（或失败 / 已通过数）与回退次数；正在启动、合并的节点另起一行。 */
export function WorkflowProgress({
  workflow,
  className,
}: {
  workflow: TaskWorkflow;
  className?: string;
}) {
  const t = useT();
  const separator = t('orchestration.workflow.separator');
  // 旧快照可能缺少运行状态字段
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const launches = Array.isArray(workflow.launches) ? workflow.launches : [];
  const names = (ids: readonly string[]) =>
    ids.map((id) => steps.find((step) => step.id === id)?.name ?? id).join(separator);
  const withStatus = (status: string) =>
    nodes.filter((node) => node.status === status).map((node) => node.id);
  const running = withStatus('running');
  const failed = withStatus('failed');
  const merging = nodes
    .filter((node) => node.status === 'passed' && node.merged === false)
    .map((node) => node.id);
  const starting = launches.map((launch) => launch.nodeId);
  const state =
    running.length > 0
      ? t('orchestration.workflow.running', { nodes: names(running) })
      : failed.length > 0
        ? t('orchestration.workflow.failed', { nodes: names(failed) })
        : t('orchestration.workflow.passed', {
            done: withStatus('passed').length,
            total: steps.length,
          });
  const busy = [
    ...(starting.length > 0
      ? [t('orchestration.workflow.starting', { nodes: names(starting) })]
      : []),
    ...(merging.length > 0 ? [t('orchestration.workflow.merging', { nodes: names(merging) })] : []),
  ];
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground', className)}
    >
      <span className="flex min-w-0 items-center gap-1">
        <Workflow className="size-3 shrink-0" />
        <span className="truncate">
          {t('orchestration.workflow.progress', {
            name: workflow.name,
            state,
            rounds: workflow.rounds,
            max: workflow.maxRounds,
          })}
        </span>
      </span>
      {busy.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-300">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{busy.join(' · ')}</span>
        </span>
      )}
    </div>
  );
}

/** 抽屉 / 视图里的小节标题。 */
export function SectionTitle({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">{children}</h3>
      {aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
    </div>
  );
}
