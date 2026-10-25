import type { SessionSummary } from '@shared/types/chat';
import { memo, useCallback, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useNow } from '@/hooks/useNow';
import { SessionSearchButton, SessionSearchInput, useFilteredSessions } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import {
  selectListErrorOf,
  selectSessionsOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { formatRelativeTime } from './format';
import { NewSessionButton } from './NewSessionButton';
import { RoleBadge, StatusDot } from './SessionBadges';

/**
 * 侧栏里某个工作区下的会话分组：角色徽标、状态点、最近更新时间。
 * 渲染为 `<li>`，挂在工作区条目之后；行用虚拟列表，滚动容器借用侧栏的 ScrollArea。
 */
export function SessionList({ workspaceId }: { workspaceId: string }) {
  const all = useSessionsStore(selectSessionsOf(workspaceId));
  const sessions = useFilteredSessions(all);
  const error = useSessionsStore(selectListErrorOf(workspaceId));
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const anchor = useCallback((node: HTMLElement | null) => {
    setScrollParent(node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null);
  }, []);

  return (
    <li ref={anchor} className="pb-1 pl-6">
      <div className="flex h-7 items-center justify-between pr-1 pl-2">
        <span className="text-muted-foreground text-xs">会话</span>
        <span className="flex items-center">
          <SessionSearchButton />
          <NewSessionButton compact />
        </span>
      </div>
      <SessionSearchInput workspaceId={workspaceId} />
      {error && <p className="px-2 py-1 text-destructive text-xs">读取会话失败：{error}</p>}
      {sessions.length === 0 ? (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {all.length === 0 ? '暂无会话' : '没有匹配的会话'}
        </p>
      ) : (
        scrollParent && (
          <Virtuoso
            customScrollParent={scrollParent}
            data={sessions}
            computeItemKey={(_, session) => session.id}
            itemContent={(_, session) => <SessionRow session={session} />}
          />
        )
      )}
    </li>
  );
}

const SessionRow = memo(function SessionRow({ session }: { session: SessionSummary }) {
  const active = useSessionsStore((state) => state.activeSessionId === session.id);
  const status = useSessionsStore(selectStatusOf(session.id));
  const select = useSessionsStore((state) => state.selectSession);
  const now = useNow();

  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={() => void select(session.id)}
      className={cn(
        'mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      <StatusDot status={status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={session.title}>
          {session.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <RoleBadge roleId={session.roleId} className="max-w-28 truncate" />
          <span className="truncate">{formatRelativeTime(session.updatedAt, now)}</span>
        </span>
      </span>
    </button>
  );
});
