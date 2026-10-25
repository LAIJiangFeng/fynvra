import { ArrowDownToLine, Loader2, Pause, Play, RotateCw } from 'lucide-react';
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type OutputEntry, useOrchestrationStore } from '@/stores/orchestration';
import { SectionTitle } from './common';
import { type OutputLineKind, outputLineKind } from './format';

const LINE_TONE: Record<OutputLineKind, string> = {
  text: '',
  user: 'text-muted-foreground',
  tool: 'text-sky-700 dark:text-sky-300',
  'tool-done': 'text-muted-foreground',
  error: 'text-destructive',
  notice: 'text-amber-700 dark:text-amber-300',
  settled: 'text-emerald-700 dark:text-emerald-300',
};

/** 离底部这么近就算「在底部」，新输出到来时继续跟随。 */
const STICK_PX = 24;

/**
 * 一次尝试的 worker 输出：等宽、自动滚到底；向上滚动或点「暂停」后停止跟随，
 * 暂停时画面冻结在当时的内容（后台照常拉取），继续后一次补齐。
 */
export function WorkerOutput({ dispatchId }: { dispatchId: string }) {
  const watchOutput = useOrchestrationStore((state) => state.watchOutput);
  const retryOutput = useOrchestrationStore((state) => state.retryOutput);
  const entry = useOrchestrationStore((state) => state.outputs[dispatchId]);
  const [frozen, setFrozen] = useState<OutputEntry | null>(null);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => watchOutput(dispatchId), [watchOutput, dispatchId]);

  const shown = frozen ?? entry;
  const paused = frozen !== null;
  const pending = paused && entry ? entry.cursor - frozen.cursor : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变长（cursor 前进）时才需要滚动
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following && !paused) element.scrollTop = element.scrollHeight;
  }, [shown?.cursor, following, paused]);

  const jumpToBottom = () => {
    setFrozen(null);
    setFollowing(true);
  };

  let status: ReactNode;
  if (!entry) status = t('common.loading');
  else if (entry.error) status = <span className="text-destructive">{t('common.loadFailed')}</span>;
  else if (paused) {
    status =
      pending > 0 ? t('orchestration.pausedNew', { count: pending }) : t('orchestration.paused');
  } else if (entry.done) status = t('orchestration.finished');
  else {
    status = (
      <span className="flex items-center gap-1 text-sky-700 dark:text-sky-300">
        <Loader2 className="size-3 animate-spin" />
        {t('orchestration.running')}
      </span>
    );
  }

  return (
    <section aria-label={t('orchestration.output')}>
      <SectionTitle
        aside={
          <>
            <span className="text-muted-foreground text-xs">{status}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t(paused ? 'orchestration.resume' : 'orchestration.pause')}
              title={t(paused ? 'orchestration.resume' : 'orchestration.pause')}
              disabled={!entry || (entry.done && !paused)}
              onClick={() => (paused ? jumpToBottom() : setFrozen(entry ?? null))}
            >
              {paused ? <Play /> : <Pause />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('chat.scrollToBottom')}
              title={t('chat.scrollToBottom')}
              disabled={following && !paused}
              onClick={jumpToBottom}
            >
              <ArrowDownToLine />
            </Button>
          </>
        }
      >
        {t('orchestration.output')}
      </SectionTitle>
      <div
        ref={scrollRef}
        className="h-72 overflow-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_PX;
          if (atBottom !== following) setFollowing(atBottom);
        }}
      >
        {shown && shown.dropped > 0 && (
          <p className="mb-1 text-muted-foreground">
            {t('orchestration.droppedChars', { count: shown.dropped })}
          </p>
        )}
        {shown && shown.pages.length > 0 ? (
          <pre className="whitespace-pre-wrap break-words font-mono">
            <OutputPages pages={shown.pages} start={shown.dropped} />
          </pre>
        ) : (
          <p className="text-muted-foreground">
            {t(entry?.done ? 'orchestration.noOutput' : 'orchestration.waitingOutput')}
          </p>
        )}
        {entry?.error && (
          <div className="mt-2 flex items-center gap-2 font-sans text-destructive text-xs">
            <span className="min-w-0 break-words">{entry.error}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => retryOutput(dispatchId)}
            >
              <RotateCw />
              {t('common.retry')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 每页单独 memo：追加输出时只渲染新页（或被合并的最后一页）。 */
function OutputPages({ pages, start }: { pages: string[]; start: number }) {
  let offset = start;
  // 上一页停在半行时，这一页的第一行是它的续接，沿用它的颜色；null 表示上一页以换行结束
  let carry: OutputLineKind | null = null;
  return pages.map((page) => {
    const key = offset;
    const lead = carry;
    offset += page.length;
    const lastBreak = page.lastIndexOf('\n');
    const tail = page.slice(lastBreak + 1);
    if (tail === '') carry = null;
    else if (lastBreak >= 0) carry = outputLineKind(tail);
    else carry = lead ?? outputLineKind(tail);
    return <OutputPage key={key} text={page} lead={lead} />;
  });
}

const OutputPage = memo(function OutputPage({
  text,
  lead,
}: {
  text: string;
  lead: OutputLineKind | null;
}) {
  const lines = text.split('\n');
  return lines.map((line, index) => {
    const kind = index === 0 && lead !== null ? lead : outputLineKind(line);
    const last = index === lines.length - 1;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: 行在页内的位置就是它的身份，页只会整体替换
      <span key={index} className={cn(LINE_TONE[kind])}>
        {line}
        {last ? '' : '\n'}
      </span>
    );
  });
});
