import type { TaskStatus } from '@fynvra/core';
import { Bot, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useRolesStore } from '@/stores/roles';
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from './format';

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
  return (
    <Badge className={cn('border-transparent', TASK_STATUS_TONE[status].badge)}>
      {TASK_STATUS_LABEL[status]}
    </Badge>
  );
}

/** 角色徽标：有对应角色时显示角色名，否则显示 id（角色可能已被删除）。 */
export function RoleBadge({ roleId }: { roleId: string }) {
  const name = useRolesStore((state) => state.roles.find((role) => role.id === roleId)?.name);
  return (
    <Badge variant="outline" className="max-w-32" title={`角色：${name ?? roleId}`}>
      <Bot />
      <span className="truncate">{name ?? roleId}</span>
    </Badge>
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
