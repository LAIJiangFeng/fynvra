import type { SessionSummary } from '@shared/types/chat';
import { Archive, ArchiveRestore, ChevronRight } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/useNow';
import { SessionSearchButton, SessionSearchInput, useFilteredSessions } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import {
  isBusy,
  selectArchivedSessionsOf,
  selectListErrorOf,
  selectSessionsOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { formatRelativeTime } from './format';
import { NewSessionButton } from './NewSessionButton';
import { RoleBadge, StatusDot } from './SessionBadges';

/** 虚拟列表的一行：会话，或「已归档」分组的开关 */
type Row = { kind: 'session'; session: SessionSummary } | { kind: 'archived'; count: number };

/**
 * 侧栏里某个工作区下的会话分组：角色徽标、状态点、最近更新时间；归档的会话收在底部可折叠的「已归档」里。
 * 渲染为 `<li>`，挂在工作区条目之后；行用虚拟列表，滚动容器借用侧栏的 ScrollArea。
 */
export function SessionList({ workspaceId }: { workspaceId: string }) {
  const all = useSessionsStore(selectSessionsOf(workspaceId));
  const sessions = useFilteredSessions(all);
  const error = useSessionsStore(selectListErrorOf(workspaceId));
  const archived = useSessionsStore(selectArchivedSessionsOf(workspaceId));
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const anchor = useCallback((node: HTMLElement | null) => {
    setScrollParent(node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null);
  }, []);

  const rows = useMemo<Row[]>(
    () => [
      ...sessions.map((session) => ({ kind: 'session' as const, session })),
      ...(archived.length > 0 ? [{ kind: 'archived' as const, count: archived.length }] : []),
      ...(archivedOpen ? archived.map((session) => ({ kind: 'session' as const, session })) : []),
    ],
    [sessions, archived, archivedOpen]
  );

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
      {sessions.length === 0 && (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {all.length === 0 ? '暂无会话' : '没有匹配的会话'}
        </p>
      )}
      {rows.length > 0 && scrollParent && (
        <Virtuoso
          customScrollParent={scrollParent}
          data={rows}
          computeItemKey={(_, row) => (row.kind === 'session' ? row.session.id : 'archived')}
          itemContent={(_, row) =>
            row.kind === 'session' ? (
              <SessionRow session={row.session} />
            ) : (
              <ArchivedToggle
                count={row.count}
                open={archivedOpen}
                onToggle={() => setArchivedOpen((open) => !open)}
              />
            )
          }
        />
      )}
    </li>
  );
}

function ArchivedToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="mt-1 mb-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      已归档
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

const SessionRow = memo(function SessionRow({ session }: { session: SessionSummary }) {
  const active = useSessionsStore((state) => state.activeSessionId === session.id);
  const status = useSessionsStore(selectStatusOf(session.id));
  const select = useSessionsStore((state) => state.selectSession);
  const archive = useSessionsStore((state) => state.archiveSession);
  const unarchive = useSessionsStore((state) => state.unarchiveSession);
  const now = useNow();
  const archived = session.archivedAt !== undefined;
  const action = archived ? '恢复' : '归档';

  return (
    <div className="group/session relative mb-0.5">
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={() => void select(session.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
      {/* 运行中、等审批的会话不能归档 */}
      {(archived || !isBusy(status)) && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={action}
          title={action}
          onClick={() => void (archived ? unarchive(session.id) : archive(session.id))}
          className="absolute top-1/2 right-1 -translate-y-1/2 bg-sidebar-accent opacity-0 hover:bg-background focus-visible:opacity-100 group-hover/session:opacity-100"
        >
          {archived ? <ArchiveRestore /> : <Archive />}
        </Button>
      )}
    </div>
  );
});
