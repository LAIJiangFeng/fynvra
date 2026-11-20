import type { SessionProfile } from '@fynvra/core';
import type { SessionStatus } from '@shared/types/chat';
import { Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';
import { useWorkspacesStore } from '@/stores/workspaces';
import { isOrchestratorRole, useRoles } from './roles';

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: 'bg-muted-foreground/40',
  running: 'animate-pulse bg-sky-500',
  'waiting-approval': 'animate-pulse bg-amber-500',
  error: 'bg-destructive',
};

/** 会话状态点：空闲灰、运行中蓝、等待审批琥珀、出错红；空闲但还有 worker 在跑的主 agent 为蓝色空心圆环。 */
export function StatusDot({
  status,
  awaitingWorkers,
  className,
}: {
  status: SessionStatus;
  awaitingWorkers?: boolean;
  className?: string;
}) {
  const t = useT();
  const awaiting = status === 'idle' && awaitingWorkers === true;
  const label = awaiting ? t('sessions.status.awaitingWorkers') : t(`sessions.status.${status}`);
  return (
    <span className={cn('relative inline-flex shrink-0', className)} title={label}>
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          awaiting ? 'ring-[1.5px] ring-sky-500 ring-inset' : STATUS_DOT[status]
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * 标题行 / 状态栏显示的分支（与会话 cwd）。无 git 工作区的会话不显示：按普通目录挂入的仓库子目录
 * 也读得到外层仓库的分支，但这个工作区不用 git。
 */
export function useSessionBranch(sessionId: string): { branch: string; cwd: string } | undefined {
  const branch = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.branch);
  const cwd = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.cwd);
  const workspaceId = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.workspaceId);
  const plain = useWorkspacesStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.vcs === 'none'
  );
  return branch && cwd && !plain ? { branch, cwd } : undefined;
}

/** 角色徽标；主 agent（orchestrator）带皇冠、紫色。 */
export function RoleBadge({
  roleId,
  profile,
  className,
}: {
  roleId: string;
  profile?: SessionProfile;
  className?: string;
}) {
  const roles = useRoles();
  const t = useT();
  // 分诊会话只是借内置 worker 作底子，显示「分诊」而不是角色名，免得误以为是 worker 在处理问题
  const name =
    profile === 'triage'
      ? t('approval.profileBadge.triage')
      : (roles.find((role) => role.id === roleId)?.name ?? roleId);
  const restricted = profile === 'restricted' && (
    <span className="rounded-sm bg-muted px-1 font-normal text-[10px] text-muted-foreground">
      {t('approval.profileBadge.restricted')}
    </span>
  );
  if (profile !== 'triage' && isOrchestratorRole(roleId, roles)) {
    return (
      <Badge
        className={cn(
          'border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300',
          className
        )}
      >
        <Crown />
        {name}
        {restricted}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      {name}
      {restricted}
    </Badge>
  );
}
