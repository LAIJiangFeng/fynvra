import type { SessionStatus } from '@shared/types/chat';
import { ArrowDown, ChevronRight, LoaderCircle, MessagesSquare, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Components, Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import {
  isBusy,
  selectLoadingHistoryOf,
  selectMessagesOf,
  selectStatusOf,
  type TimelineMessage,
  useSessionsStore,
} from '@/stores/sessions';
import {
  buildTimelineRows,
  formatTurnTime,
  reuseRows,
  type TimelineRow,
} from '@/stores/sessions/timeline';
import { useGeneralPreferencesStore } from '@/stores/settings';
import { MessageItem } from './MessageItem';
import {
  createRunningSilence,
  type RunningActivity,
  runningActivityOf,
  sameRunningActivity,
} from './runningSilence';

interface TimelineContext {
  status: SessionStatus;
  showWorking: boolean;
  error: string | undefined;
}

// 组件表放在模块级：每次渲染传新对象会让 Virtuoso 重新挂载页眉页脚
const COMPONENTS: Components<TimelineRow, TimelineContext> = {
  Header: () => <div className="h-4" />,
  Footer: ({ context }) => <TimelineFooter {...context} />,
};

function TimelineFooter({ status, showWorking, error }: TimelineContext) {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl px-6 pb-6">
      {/* 固定提示行高度，静默提示的显隐不移动正文或改变历史阅读位置。 */}
      <div className="h-8">
        {((status === 'running' && showWorking) || status === 'waiting-approval') && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-2 text-muted-foreground text-xs"
          >
            {status === 'running' && (
              <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
            )}
            {t(status === 'running' ? 'chat.working' : 'sessions.status.waiting-approval')}
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 会话时间线：虚拟列表；贴底时跟随流式输出，用户往上滚就停止跟随。
 * 行由 {@link buildTimelineRows} 按「通用 → 时间线」的偏好分好（只读工具合并、历史轮次折叠）。
 */
export function Timeline({ sessionId }: { sessionId: string }) {
  const messages = useSessionsStore(selectMessagesOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const error = useSessionsStore((state) => state.runtimeBySession[sessionId]?.error);
  const loading = useSessionsStore(selectLoadingHistoryOf(sessionId));
  const compactReadonlyTools = useGeneralPreferencesStore(
    (state) => state.timeline.compactReadonlyTools
  );
  const foldHistoryTurns = useGeneralPreferencesStore((state) => state.timeline.foldHistoryTurns);
  // 用户手动展开的历史轮次（按提问消息 id），会话内记住
  const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(() => new Set());
  const t = useT();

  // 内容没变的行沿用上次的对象，流式输出时只重画变了的行
  const committedRows = useRef<TimelineRow[]>([]);
  const rows = useMemo(
    () =>
      reuseRows(
        committedRows.current,
        buildTimelineRows(messages, { compactReadonlyTools, foldHistoryTurns, openTurns })
      ),
    [messages, compactReadonlyTools, foldHistoryTurns, openTurns]
  );
  useEffect(() => {
    committedRows.current = rows;
  }, [rows]);

  const last = messages.at(-1);
  const busy = isBusy(status);
  const [silentActivity, setSilentActivity] = useState<RunningActivity>();
  useLayoutEffect(() => {
    const silence = createRunningSilence(() => {
      const state = useSessionsStore.getState();
      return runningActivityOf(
        sessionId,
        selectStatusOf(sessionId)(state),
        selectMessagesOf(sessionId)(state)
      );
    }, setSilentActivity);
    // 直接观察投影，结束/停止/审批即取消，不等 React 下一次渲染才清理。
    const unsubscribe = useSessionsStore.subscribe(silence.update);
    silence.update();
    return () => {
      unsubscribe();
      silence.dispose();
    };
  }, [sessionId]);
  // 切会话或正文恢复的这一帧，也不能沿用上一次静默的显示状态。
  const showWorking =
    status === 'running' &&
    silentActivity !== undefined &&
    sameRunningActivity(silentActivity, runningActivityOf(sessionId, status, messages));
  const context = useMemo(() => ({ status, showWorking, error }), [status, showWorking, error]);
  // 最后一条提问之后的行是正在跑的这一轮：文件修改卡片按设置自动展开
  const liveFrom = useMemo(() => rows.findLastIndex((row) => row.kind === 'user'), [rows]);

  const virtuoso = useRef<VirtuosoHandle>(null);
  const follow = useRef(true);
  const detachScroll = useRef<(() => void) | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // 滚动位置变小只可能是用户往上翻（滚轮、拖滚动条、键盘）：停止跟随
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    detachScroll.current?.();
    detachScroll.current = null;
    if (!(element instanceof HTMLElement)) return;
    let lastTop = element.scrollTop;
    const onScroll = () => {
      if (element.scrollTop < lastTop - 4) follow.current = false;
      lastTop = element.scrollTop;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    detachScroll.current = () => element.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => () => detachScroll.current?.(), []);

  const toggleTurn = useCallback((questionId: string, opening: boolean) => {
    // 展开一轮历史是在看旧内容：停止跟随，否则插进来的行会把视图拉到底部
    if (opening) follow.current = false;
    setOpenTurns((open) => {
      const next = new Set(open);
      if (opening) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  }, []);

  // 最后一条消息长高（流式正文、思考、工具状态）或页脚状态变化：跟随时贴底。
  // 布局阶段调用，赶在 Virtuoso 量到新高度之前登记
  const growth = last
    ? [
        last.id,
        last.text.length,
        last.thinking?.length ?? 0,
        last.toolCalls.map((call) => call.status).join(),
      ].join(':')
    : '';
  useLayoutEffect(() => {
    if ((growth || status === 'running' || status === 'waiting-approval') && follow.current) {
      virtuoso.current?.autoscrollToBottom();
    }
  }, [growth, status]);

  // 折叠历史轮次时发了新消息：之前的轮次折起来，回到底部看新的一轮
  const sentId = foldHistoryTurns && last?.role === 'user' ? last.id : undefined;
  useLayoutEffect(() => {
    if (!sentId) return;
    follow.current = true;
    virtuoso.current?.autoscrollToBottom();
  }, [sentId]);

  if (rows.length === 0 && !busy && !error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground text-sm">
        {loading ? (
          <LoaderCircle className="size-6 animate-spin" />
        ) : (
          <>
            <MessagesSquare className="size-10 text-muted-foreground/60" />
            {t('chat.startHint')}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuoso}
        className="h-full"
        data={rows}
        context={context}
        components={COMPONENTS}
        computeItemKey={(_, row) => row.key}
        itemContent={(index, row) => (
          <div className={cn('mx-auto max-w-3xl px-6', row.kind === 'turn' ? 'py-0.5' : 'py-2')}>
            <TimelineRowView row={row} live={busy && index > liveFrom} onToggleTurn={toggleTurn} />
          </div>
        )}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        followOutput={() => (follow.current ? 'auto' : false)}
        atBottomThreshold={48}
        atBottomStateChange={(bottom) => {
          if (bottom) follow.current = true;
          setAtBottom(bottom);
        }}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        scrollerRef={scrollerRef}
      />
      {!atBottom && (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('chat.scrollToBottom')}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => {
            follow.current = true;
            virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
          }}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

const TimelineRowView = memo(function TimelineRowView({
  row,
  live,
  onToggleTurn,
}: {
  row: TimelineRow;
  /** 这一行属于正在跑的这一轮 */
  live: boolean;
  onToggleTurn: (questionId: string, opening: boolean) => void;
}) {
  if (row.kind === 'turn') {
    return <TurnHeader message={row.message} open={row.open} onToggle={onToggleTurn} />;
  }
  return (
    <MessageItem
      message={row.message}
      tools={row.kind === 'assistant' ? row.tools : undefined}
      live={live}
    />
  );
});

/** 折起来的历史轮次：一行提问 + 时间，点开接着显示整轮；只有图片的提问显示占位 */
function TurnHeader({
  message,
  open,
  onToggle,
}: {
  message: TimelineMessage;
  open: boolean;
  onToggle: (questionId: string, opening: boolean) => void;
}) {
  const t = useT();
  const question =
    message.text.replace(/\s+/g, ' ').trim() || (message.images ? t('chat.imageOnly') : '');
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onToggle(message.id, !open)}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="min-w-0 flex-1 truncate" title={question}>
        {question}
      </span>
      <span className="shrink-0 text-xs tabular-nums">
        {formatTurnTime(message.createdAt, Date.now())}
      </span>
    </button>
  );
}
