import type { Run, Task, TaskStatus } from '@fynvra/core';
import { ChevronRight, GitBranch, Link2, Loader2, MessageSquare, Target } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrchestrationSnapshotView } from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import {
  activeDispatchOf,
  dispatchesOf,
  latestDispatchOf,
  latestMessageOfTask,
  tasksByStatus,
} from '@/stores/orchestration';
import { RoleBadge, StatusDot } from './common';
import {
  formatDuration,
  formatRelative,
  messageSummary,
  oneLine,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  TASK_STATUS_TONE,
} from './format';
import { useNow } from './hooks';

/** 「任务」tab：Run 目标一行 + 按状态分组的任务卡片。 */
export function TasksView({
  view,
  run,
  runs,
  onSelectRun,
  onOpenTask,
}: {
  view: OrchestrationSnapshotView;
  run: Run;
  runs: Run[];
  onSelectRun: (runId: string) => void;
  onOpenTask: (taskId: string, trigger: HTMLElement) => void;
}) {
  const groups = tasksByStatus(view, run.id);
  const total = TASK_STATUS_ORDER.reduce((sum, status) => sum + groups[status].length, 0);
  const now = useNow(30_000);

  return (
    <div className="flex flex-col gap-3 p-3">
      <RunHeader
        run={run}
        runs={runs}
        onSelectRun={onSelectRun}
        completed={groups.completed.length}
        total={total}
        now={now}
      />
      {total === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-xs">这次编排还没有任务</p>
      ) : (
        TASK_STATUS_ORDER.filter((status) => groups[status].length > 0).map((status) => (
          <TaskGroup
            key={status}
            status={status}
            tasks={groups[status]}
            view={view}
            now={now}
            onOpenTask={onOpenTask}
          />
        ))
      )}
    </div>
  );
}

function RunHeader({
  run,
  runs,
  onSelectRun,
  completed,
  total,
  now,
}: {
  run: Run;
  runs: Run[];
  onSelectRun: (runId: string) => void;
  completed: number;
  total: number;
  now: number;
}) {
  const items = runs.map((candidate) => ({
    value: candidate.id,
    label: oneLine(candidate.objective, 40) || candidate.id,
  }));
  return (
    <div className="rounded-md border bg-card px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Target className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate font-medium text-sm" title={run.objective}>
          {run.objective || '（未命名的编排）'}
        </p>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelative(run.createdAt, now)}
        </span>
      </div>
      <Progress
        className="mt-2"
        value={total === 0 ? 0 : (completed / total) * 100}
        aria-label="任务完成进度"
        indicatorClassName="bg-emerald-500"
      >
        <ProgressLabel>
          已完成 {completed} / {total}
        </ProgressLabel>
      </Progress>
      {runs.length > 1 && (
        <Select
          items={items}
          value={run.id}
          onValueChange={(value) => {
            if (typeof value === 'string') onSelectRun(value);
          }}
        >
          <SelectTrigger size="sm" className="mt-2 h-7 text-xs" aria-label="切换编排">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} className="text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function TaskGroup({
  status,
  tasks,
  view,
  now,
  onOpenTask,
}: {
  status: TaskStatus;
  tasks: Task[];
  view: OrchestrationSnapshotView;
  now: number;
  onOpenTask: (taskId: string, trigger: HTMLElement) => void;
}) {
  return (
    <Collapsible defaultOpen={status !== 'abandoned'}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        <StatusDot status={status} />
        {TASK_STATUS_LABEL[status]}
        <span className="ml-auto tabular-nums">{tasks.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} view={view} now={now} onOpen={onOpenTask} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskCard({
  task,
  view,
  now,
  onOpen,
}: {
  task: Task;
  view: OrchestrationSnapshotView;
  now: number;
  onOpen: (taskId: string, trigger: HTMLElement) => void;
}) {
  const latest = latestDispatchOf(view, task.id);
  const running = activeDispatchOf(view, task.id);
  const attempts = dispatchesOf(view, task.id).length;
  const message = latestMessageOfTask(view, task.id);
  const tick = useNow(1_000, running !== undefined);
  const dependencies = task.dependsOn.map(
    (id) => view.tasks.find((candidate) => candidate.id === id) ?? { id, title: id, missing: true }
  );

  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-md border border-l-[3px] bg-card px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        TASK_STATUS_TONE[task.status].border
      )}
      onClick={(event) => onOpen(task.id, event.currentTarget)}
    >
      <div className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-sm leading-snug">
          {task.title}
        </span>
        <RoleBadge roleId={task.roleId} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
        {latest && latest.mode !== 'in-place' && (
          <span className="flex min-w-0 max-w-full items-center gap-1 font-mono">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{latest.branch}</span>
          </span>
        )}
        {running && (
          <span className="flex items-center gap-1 text-sky-700 tabular-nums dark:text-sky-300">
            <Loader2 className="size-3 animate-spin" />
            {formatDuration(tick - running.startedAt)}
          </span>
        )}
        {attempts > 1 && <span>第 {attempts} 次尝试</span>}
      </div>

      {dependencies.length > 0 && (
        <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Link2 className="size-3 shrink-0" />
          <span className="truncate">
            依赖：
            {dependencies.map((dependency, index) => (
              <span
                key={dependency.id}
                className={cn(
                  'status' in dependency && dependency.status === 'completed'
                    ? ''
                    : 'text-amber-700 dark:text-amber-300'
                )}
              >
                {index > 0 && '、'}
                {dependency.title}
              </span>
            ))}
          </span>
        </p>
      )}

      {message && (
        <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <MessageSquare className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{messageSummary(message)}</span>
          <span className="shrink-0">{formatRelative(message.createdAt, now)}</span>
        </p>
      )}
    </button>
  );
}
