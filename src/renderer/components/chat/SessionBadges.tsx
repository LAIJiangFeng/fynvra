import type { SessionStatus } from '@shared/types/chat';
import { Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { isOrchestratorRole, useRoles } from './roles';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  'waiting-approval': '等待审批',
  error: '出错',
};

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: 'bg-muted-foreground/40',
  running: 'animate-pulse bg-sky-500',
  'waiting-approval': 'animate-pulse bg-amber-500',
  error: 'bg-destructive',
};

/** 会话状态点：空闲灰、运行中蓝、等待审批琥珀、出错红。 */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} title={STATUS_LABEL[status]}>
      <span aria-hidden className={cn('size-2 rounded-full', STATUS_DOT[status])} />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** 角色徽标；主 agent（orchestrator）带皇冠、紫色。 */
export function RoleBadge({ roleId, className }: { roleId: string; className?: string }) {
  const roles = useRoles();
  const name = roles.find((role) => role.id === roleId)?.name ?? roleId;
  if (isOrchestratorRole(roleId, roles)) {
    return (
      <Badge
        className={cn(
          'border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300',
          className
        )}
      >
        <Crown />
        {name}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      {name}
    </Badge>
  );
}
