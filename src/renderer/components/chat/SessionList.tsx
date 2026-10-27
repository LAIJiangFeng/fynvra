import type { SessionSummary } from '@shared/types/chat';
import { Archive, ArchiveRestore, ChevronRight, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useNow } from '@/hooks/useNow';
import { useT } from '@/i18n/I18nProvider';
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
  const sessions = useFilteredSessions(workspaceId, all);
  const loadSessions = useSessionsStore((state) => state.loadSessions);
  // 展开其他工作区只加载列表，不切换正在查看的会话
  useEffect(() => {
    void loadSessions(workspaceId);
  }, [workspaceId, loadSessions]);
  const error = useSessionsStore(selectListErrorOf(workspaceId));
  const archived = useSessionsStore(selectArchivedSessionsOf(workspaceId));
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const t = useT();
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
        <span className="text-muted-foreground text-xs">{t('sessions.title')}</span>
        <span className="flex items-center">
          <SessionSearchButton workspaceId={workspaceId} />
          <NewSessionButton workspaceId={workspaceId} compact />
        </span>
      </div>
      <SessionSearchInput workspaceId={workspaceId} />
      {error && (
        <p className="px-2 py-1 text-destructive text-xs">{t('sessions.loadFailed', { error })}</p>
      )}
      {sessions.length === 0 && (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {t(all.length === 0 ? 'sessions.empty' : 'sessions.noMatch')}
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
  const t = useT();
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="mt-1 mb-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      {t('sessions.archived')}
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

const SessionRow = memo(function SessionRow({ session }: { session: SessionSummary }) {
  const active = useSessionsStore(
    (state) => state.workspaceId === session.workspaceId && state.activeSessionId === session.id
  );
  const status = useSessionsStore(selectStatusOf(session.id));
  const select = useSessionsStore((state) => state.selectSession);
  const archive = useSessionsStore((state) => state.archiveSession);
  const unarchive = useSessionsStore((state) => state.unarchiveSession);
  const remove = useSessionsStore((state) => state.removeSession);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const now = useNow();
  const t = useT();
  const archived = session.archivedAt !== undefined;
  const action = t(archived ? 'sessions.unarchive' : 'sessions.archive');
  const busy = isBusy(status);

  return (
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <div className="group/session relative mb-0.5">
        <button
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => void select(session.id, session.workspaceId)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-1.5 pr-16 pl-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
              <span className="truncate">{formatRelativeTime(session.updatedAt, now, t)}</span>
            </span>
          </span>
        </button>
        {/* 运行中、等审批的会话不能归档或删除；已归档的仍可恢复。 */}
        {(archived || !busy) && (
          <div className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5 rounded-md bg-sidebar-accent opacity-0 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={action}
              title={action}
              onClick={() => void (archived ? unarchive(session.id) : archive(session.id))}
              className="hover:bg-background"
            >
              {archived ? <ArchiveRestore /> : <Archive />}
            </Button>
            {!busy && (
              <DialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('sessions.remove')}
                    title={t('sessions.remove')}
                    className="hover:bg-background hover:text-destructive"
                  />
                }
              >
                <Trash2 />
              </DialogTrigger>
            )}
          </div>
        )}
      </div>
      <DialogContent initialFocus={cancel} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('sessions.removeTitle')}</DialogTitle>
          <DialogDescription>{t('sessions.removeHint')}</DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm">{session.title}</p>
        <DialogFooter>
          <DialogClose render={<Button ref={cancel} variant="outline" />}>
            {t('common.cancel')}
          </DialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setConfirmOpen(false);
              void remove(session.id);
            }}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
