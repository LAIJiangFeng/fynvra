import { ArrowDown, ChevronRight, LoaderCircle, MessagesSquare, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Components, Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
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

interface TimelineContext {
  busy: boolean;
  /** 最后一条 assistant 正在流式输出正文 */
  streaming: boolean;
  error: string | undefined;
}

// 组件表放在模块级：每次渲染传新对象会让 Virtuoso 重新挂载页眉页脚
const COMPONENTS: Components<TimelineRow, TimelineContext> = {
  Header: () => <div className="h-4" />,
  Footer: ({ context }) => <TimelineFooter {...context} />,
};

function TimelineFooter({ busy, streaming, error }: TimelineContext) {
  return (
    <div className="mx-auto max-w-3xl px-6 pb-6">
      {busy && !streaming && (
        <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
          <LoaderCircle className="size-3.5 animate-spin" />
          agent 正在工作…
        </div>
      )}
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
  const streaming = Boolean(last?.role === 'assistant' && last.streaming && last.text);
  const context = useMemo(() => ({ busy, streaming, error }), [busy, streaming, error]);
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

  // 最后一条消息在长高（流式正文、思考、工具状态）：跟随时贴底。
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
    if (growth && follow.current) virtuoso.current?.autoscrollToBottom();
  }, [growth]);

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
            发送第一条消息开始对话
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
          aria-label="回到底部"
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

/** 折起来的历史轮次：一行提问 + 时间，点开接着显示整轮 */
function TurnHeader({
  message,
  open,
  onToggle,
}: {
  message: TimelineMessage;
  open: boolean;
  onToggle: (questionId: string, opening: boolean) => void;
}) {
  const question = message.text.replace(/\s+/g, ' ').trim();
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
