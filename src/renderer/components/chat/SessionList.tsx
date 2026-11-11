import type { SessionSummary } from '@shared/types/chat';
import { Archive, ArchiveRestore, ChevronRight, ListChecks, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  statusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { formatRelativeTime } from './format';
import { NewSessionButton } from './NewSessionButton';
import { RoleBadge, StatusDot } from './SessionBadges';
import { SessionModelBadge } from './SessionModelBadge';

/** 虚拟列表的一行：会话，或「已归档」分组的开关 */
type Row = { kind: 'session'; session: SessionSummary } | { kind: 'archived'; count: number };

/**
 * 侧栏里某个工作区下的会话分组：角色徽标、模型、状态点、最近更新时间；归档的会话收在底部可折叠的「已归档」里。
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const bulkBusy = useSessionsStore((state) => state.bulkWorkspaceId !== null);
  const archiveIdle = useSessionsStore((state) => state.archiveIdleSessions);
  const archiveMany = useSessionsStore((state) => state.archiveSessions);
  const requestRemove = useSessionsStore((state) => state.requestRemoveSessions);
  const t = useT();
  const selectAllId = useId();
  const exitSelect = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);
  const toggle = useCallback((sessionId: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
  // 已不在列表里的（别处删掉的）不算
  const picked = [...all, ...archived].filter((session) => selected.has(session.id));
  const pickedActive = picked.filter((session) => session.archivedAt === undefined);
  // 全选：当前显示的、能操作的会话（运行中、等审批的未归档会话不勾）
  const selectable = () => {
    const state = useSessionsStore.getState();
    return [...sessions, ...(archivedOpen ? archived : [])]
      .filter((session) => session.archivedAt !== undefined || !isBusy(statusOf(state, session.id)))
      .map((session) => session.id);
  };
  const allPicked = picked.length > 0 && selectable().every((id) => selected.has(id));
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
    <li
      ref={anchor}
      className="pb-1 pl-6"
      onKeyDown={(event) => {
        if (selecting && event.key === 'Escape' && !event.defaultPrevented) exitSelect();
      }}
    >
      <div className="flex h-7 items-center justify-between pr-1 pl-2">
        <span className="text-muted-foreground text-xs">{t('sessions.title')}</span>
        <span className="flex items-center">
          <SessionSearchButton workspaceId={workspaceId} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('sessions.bulk.archiveIdle')}
            title={t('sessions.bulk.archiveIdle')}
            disabled={bulkBusy || sessions.length === 0}
            onClick={() => void archiveIdle(workspaceId)}
          >
            <Archive />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('sessions.bulk.select')}
            aria-pressed={selecting}
            title={t('sessions.bulk.select')}
            disabled={all.length + archived.length === 0}
            onClick={() => (selecting ? exitSelect() : setSelecting(true))}
          >
            <ListChecks />
          </Button>
          <NewSessionButton workspaceId={workspaceId} compact />
        </span>
      </div>
      {selecting && (
        <div className="flex h-7 items-center gap-1 pr-1 pl-2 text-xs">
          <label
            htmlFor={selectAllId}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
          >
            <Checkbox
              id={selectAllId}
              checked={allPicked}
              indeterminate={picked.length > 0 && !allPicked}
              onCheckedChange={(on) => setSelected(new Set(on ? selectable() : []))}
            />
            <span className="truncate text-muted-foreground">
              {picked.length > 0
                ? t('sessions.bulk.selected', { count: picked.length })
                : t('sessions.bulk.selectAll')}
            </span>
          </label>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('sessions.archive')}
            title={t('sessions.archive')}
            disabled={bulkBusy || pickedActive.length === 0}
            onClick={() => {
              exitSelect();
              void archiveMany(
                workspaceId,
                pickedActive.map((session) => session.id)
              );
            }}
          >
            <Archive />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.delete')}
            title={t('common.delete')}
            disabled={bulkBusy || picked.length === 0}
            onClick={() =>
              requestRemove(
                workspaceId,
                picked.map((session) => session.id)
              )
            }
            className="hover:text-destructive"
          >
            <Trash2 />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={exitSelect}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
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
              <SessionRow
                session={row.session}
                checked={selecting ? selected.has(row.session.id) : undefined}
                onCheck={toggle}
              />
            ) : (
              <ArchivedToggle
                count={row.count}
                open={archivedOpen}
                onToggle={() => setArchivedOpen((open) => !open)}
                onRemoveAll={
                  bulkBusy
                    ? undefined
                    : () =>
                        requestRemove(
                          workspaceId,
                          archived.map((session) => session.id)
                        )
                }
              />
            )
          }
        />
      )}
      <BulkRemoveDialog workspaceId={workspaceId} onDone={exitSelect} />
    </li>
  );
}

/** 删除的确认框（单个与批量共用）：只在 store 登记了本工作区的待确认删除时打开 */
function BulkRemoveDialog({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const pending = useSessionsStore((state) =>
    state.pendingRemoval?.workspaceId === workspaceId ? state.pendingRemoval : null
  );
  const confirm = useSessionsStore((state) => state.confirmRemoveSessions);
  const cancelRemove = useSessionsStore((state) => state.cancelRemoveSessions);
  const [force, setForce] = useState(false);
  const forceId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const t = useT();
  const count = pending?.sessionIds.length ?? 0;
  const blocked = pending?.blocked?.length ?? 0;
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        setForce(false);
        if (!open) cancelRemove();
      }}
    >
      <DialogContent initialFocus={cancel} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {count === 1 ? t('sessions.removeTitle') : t('sessions.bulk.removeTitle', { count })}
          </DialogTitle>
          <DialogDescription>
            {t(count === 1 ? 'sessions.removeHint' : 'sessions.bulk.removeHint')}
          </DialogDescription>
        </DialogHeader>
        {pending?.blocked === null && (
          <p className="text-muted-foreground text-sm">{t('sessions.bulk.checkingWorktrees')}</p>
        )}
        {blocked > 0 && (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              {t('sessions.bulk.unmergedCount', { count: blocked })}
            </p>
            <label htmlFor={forceId} className="flex cursor-pointer items-center gap-2">
              <Checkbox id={forceId} checked={force} onCheckedChange={(on) => setForce(on)} />
              {t('sessions.bulk.forceUnmerged')}
            </label>
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button ref={cancel} variant="outline" />}>
            {t('common.cancel')}
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending?.blocked === null}
            onClick={() => {
              onDone();
              setForce(false);
              void confirm(force);
            }}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchivedToggle({
  count,
  open,
  onToggle,
  onRemoveAll,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  /** 删除全部已归档（先弹确认）；批量操作进行中时不给 */
  onRemoveAll?: () => void;
}) {
  const t = useT();
  return (
    <div className="group/archived relative pt-1 pb-0.5">
      {onRemoveAll && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('sessions.bulk.removeArchived')}
          title={t('sessions.bulk.removeArchived')}
          onClick={onRemoveAll}
          className="absolute top-1.5 right-1 opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover/archived:opacity-100"
        >
          <Trash2 />
        </Button>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {t('sessions.archived')}
        <span className="tabular-nums">{count}</span>
      </button>
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  checked,
  onCheck,
}: {
  session: SessionSummary;
  /** 选择模式下是否勾选；undefined 表示不在选择模式 */
  checked?: boolean;
  onCheck: (sessionId: string, on: boolean) => void;
}) {
  const active = useSessionsStore(
    (state) => state.workspaceId === session.workspaceId && state.activeSessionId === session.id
  );
  const status = useSessionsStore(selectStatusOf(session.id));
  const select = useSessionsStore((state) => state.selectSession);
  const archive = useSessionsStore((state) => state.archiveSession);
  const unarchive = useSessionsStore((state) => state.unarchiveSession);
  const requestRemove = useSessionsStore((state) => state.requestRemoveSessions);
  const now = useNow();
  const t = useT();
  const archived = session.archivedAt !== undefined;
  const action = t(archived ? 'sessions.unarchive' : 'sessions.archive');
  const busy = isBusy(status);

  const rowClass = cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
    active && 'bg-sidebar-accent text-sidebar-accent-foreground'
  );

  if (checked !== undefined) {
    // 选择模式：整行是标签，点哪里都能勾；运行中、等审批的未归档会话不能选
    const disabled = busy && !archived;
    const id = `session-pick-${session.id}`;
    return (
      <div className="pb-0.5">
        <label
          htmlFor={id}
          className={cn(rowClass, disabled ? 'cursor-default opacity-60' : 'cursor-pointer')}
        >
          <Checkbox
            id={id}
            aria-label={t('sessions.bulk.selectSession', { title: session.title })}
            checked={checked && !disabled}
            disabled={disabled}
            onCheckedChange={(on) => onCheck(session.id, on)}
          />
          <StatusDot status={status} />
          <span className="block h-7 min-w-0 flex-1 truncate leading-7" title={session.title}>
            {session.title}
          </span>
        </label>
      </div>
    );
  }

  return (
    <div className="group/session relative pb-0.5">
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={() => void select(session.id, session.workspaceId)}
        className={rowClass}
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1">
          {/* Only the title reserves space for the hover actions; metadata gets the full width. */}
          <span className="block h-7 truncate pr-14 leading-7" title={session.title}>
            {session.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <RoleBadge roleId={session.roleId} className="min-w-0 max-w-[60%] shrink truncate" />
            <span className="min-w-0 flex-1 truncate text-right">
              {formatRelativeTime(session.updatedAt, now, t)}
            </span>
          </span>
          <SessionModelBadge model={session.model} />
        </span>
      </button>
      {/* 运行中、等审批的会话不能归档或删除；已归档的仍可恢复。 */}
      {(archived || !busy) && (
        <div className="pointer-events-none absolute top-1.5 right-1 flex gap-0.5 rounded-md bg-sidebar-accent opacity-0 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100">
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
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('sessions.remove')}
              title={t('sessions.remove')}
              onClick={() => requestRemove(session.workspaceId, [session.id])}
              className="hover:bg-background hover:text-destructive"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
