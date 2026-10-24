import { ArrowDown, LoaderCircle, MessagesSquare, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Components, Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import {
  isBusy,
  selectLoadingHistoryOf,
  selectMessagesOf,
  selectStatusOf,
  type TimelineMessage,
  useSessionsStore,
} from '@/stores/sessions';
import { isVisibleMessage, MessageItem } from './MessageItem';

interface TimelineContext {
  busy: boolean;
  /** 最后一条 assistant 正在流式输出正文 */
  streaming: boolean;
  error: string | undefined;
}

// 组件表放在模块级：每次渲染传新对象会让 Virtuoso 重新挂载页眉页脚
const COMPONENTS: Components<TimelineMessage, TimelineContext> = {
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

/** 会话时间线：虚拟列表；贴底时跟随流式输出，用户往上滚就停止跟随。 */
export function Timeline({ sessionId }: { sessionId: string }) {
  const messages = useSessionsStore(selectMessagesOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const error = useSessionsStore((state) => state.runtimeBySession[sessionId]?.error);
  const loading = useSessionsStore(selectLoadingHistoryOf(sessionId));

  const visible = useMemo(() => messages.filter(isVisibleMessage), [messages]);
  const last = messages.at(-1);
  const busy = isBusy(status);
  const streaming = Boolean(last?.role === 'assistant' && last.streaming && last.text);
  const context = useMemo(() => ({ busy, streaming, error }), [busy, streaming, error]);

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

  if (visible.length === 0 && !busy && !error) {
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
        data={visible}
        context={context}
        components={COMPONENTS}
        computeItemKey={(_, message) => message.id}
        itemContent={(_, message) => (
          <div className="mx-auto max-w-3xl px-6 py-2">
            <MessageItem message={message} />
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
