import type { TaskStatus, TaskWorkflow } from '@fynvra/core';
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

/** 工作流任务的进度：当前步、角色、回退次数；两步之间显示正在启动的步骤。 */
export function WorkflowProgress({
  workflow,
  className,
}: {
  workflow: TaskWorkflow;
  className?: string;
}) {
  const t = useT();
  const step = workflow.steps[workflow.step];
  const pending = workflow.pending;
  const next = pending ? workflow.steps[pending.step] : undefined;
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground', className)}
    >
      <span className="flex min-w-0 items-center gap-1">
        <Workflow className="size-3 shrink-0" />
        <span className="truncate">
          {t('orchestration.workflow.progress', {
            name: workflow.name,
            step: workflow.step + 1,
            total: workflow.steps.length,
            stepName: step?.name ?? '?',
            role: step?.roleId ?? '?',
            rounds: workflow.rounds,
            max: workflow.maxRounds,
          })}
        </span>
      </span>
      {pending && (
        <span className="flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-300">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate">
            {t('orchestration.workflow.advancing', {
              step: pending.step + 1,
              stepName: next?.name ?? '?',
            })}
          </span>
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
