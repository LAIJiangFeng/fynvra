import { GitBranch, MessagesSquare, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import {
  selectNotice,
  selectSessionOf,
  selectSessionsOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { ApprovalBar } from './ApprovalBar';
import { Composer } from './Composer';
import { NewSessionButton } from './NewSessionButton';
import { RoleBadge, StatusDot, useSessionBranch } from './SessionBadges';
import { StatusBar } from './StatusBar';
import { Timeline } from './Timeline';

/** 聊天视图：会话标题、时间线、审批条、输入框、底部状态栏。按会话 key 挂载。 */
export function ChatView({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore(selectSessionOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const branch = useSessionBranch(sessionId);
  const t = useT();

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <StatusDot status={status} />
        <h1 className="min-w-0 truncate font-medium">{session?.title ?? t('sessions.title')}</h1>
        {session && <RoleBadge roleId={session.roleId} />}
        {branch && <BranchBadge branch={branch.branch} cwd={branch.cwd} />}
        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
          {t(`sessions.status.${status}`)}
        </span>
      </header>
      <ChatNotice />
      <ChatWarning sessionId={sessionId} />
      <Timeline sessionId={sessionId} />
      <ApprovalBar sessionId={sessionId} />
      <Composer sessionId={sessionId} />
      <StatusBar sessionId={sessionId} />
    </main>
  );
}

/**
 * 分支徽标：会话 cwd 当前检出的分支（worker 会话是它 worktree 的分支，detached 时是短 sha），悬停显示 cwd。
 * 用户在外部 checkout 后，Main 重读到变化会推 sessions:changed，这里随列表刷新。
 */
function BranchBadge({ branch, cwd }: { branch: string; cwd: string }) {
  return (
    <Badge variant="outline" title={cwd} className="max-w-56 font-mono">
      <GitBranch aria-hidden />
      <span className="truncate">{branch}</span>
    </Badge>
  );
}

/** 读记录、停止、审批答复等操作失败的提示，可关闭。 */
function ChatNotice() {
  const notice = useSessionsStore(selectNotice);
  const dismiss = useSessionsStore((state) => state.dismissNotice);
  const t = useT();
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-destructive/30 border-b bg-destructive/5 py-1.5 pr-2 pl-4 text-destructive text-sm"
    >
      <span className="min-w-0 flex-1 truncate" title={notice}>
        {notice}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('sessions.dismissNotice')}
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * 非阻塞服务告警：目前用于 Magic Context 把会话交回原生压缩。琥珀色、可关闭，
 * 不改变会话状态、不等待确认，也不显示 provider 原始错误或 prompt。
 */
function ChatWarning({ sessionId }: { sessionId: string }) {
  const warning = useSessionsStore((state) => state.runtimeBySession[sessionId]?.warning);
  const [dismissed, setDismissed] = useState(false);
  const t = useT();
  if (!warning || dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-2 border-amber-500/30 border-b bg-amber-500/10 py-1.5 pr-2 pl-4 text-amber-800 text-sm dark:text-amber-200"
    >
      <span className="min-w-0 flex-1 truncate" title={t('chat.magicContextFallback')}>
        {t('chat.magicContextFallback')}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('sessions.dismissNotice')}
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}

/** 工作区已选、还没选会话时的主区域内容。 */
export function ChatPlaceholder({ workspaceId }: { workspaceId: string }) {
  const hasSessions = useSessionsStore((state) => selectSessionsOf(workspaceId)(state).length > 0);
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <MessagesSquare className="size-10 text-muted-foreground/60" />
      <p className="text-muted-foreground text-sm">
        {t(hasSessions ? 'sessions.pickOrCreate' : 'sessions.none')}
      </p>
      <NewSessionButton />
    </div>
  );
}
