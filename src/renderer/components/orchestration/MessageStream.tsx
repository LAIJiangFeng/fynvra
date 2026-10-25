import type { Dispatch, Message } from '@fynvra/core';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  CornerDownRight,
  type LucideIcon,
  Megaphone,
  MessageCircleQuestion,
  MessageSquare,
} from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/I18nProvider';
import type { OrchestrationSnapshotView } from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import { messagesOf } from '@/stores/orchestration';
import {
  describeSubject,
  formatClock,
  isFromWorker,
  messageTypeLabel,
  reportOutcome,
} from './format';

interface StreamItem {
  message: Message;
  dispatch: Dispatch;
  attempt: number;
}

function bubbleStyle(message: Message): { icon: LucideIcon; className: string } {
  switch (message.type) {
    case 'question':
      return {
        icon: MessageCircleQuestion,
        className: 'border-amber-500/30 bg-amber-500/10',
      };
    case 'reply':
      return { icon: CornerDownRight, className: 'border-sky-500/30 bg-sky-500/10' };
    case 'instruction':
      return { icon: Megaphone, className: 'border-violet-500/30 bg-violet-500/10' };
    case 'worker_done':
      return reportOutcome(message) === 'failed'
        ? { icon: CircleX, className: 'border-destructive/30 bg-destructive/10' }
        : { icon: CircleCheck, className: 'border-emerald-500/30 bg-emerald-500/10' };
    case 'escalation':
      return { icon: CircleAlert, className: 'border-destructive/30 bg-destructive/10' };
    default:
      return {
        icon: MessageSquare,
        className: 'border-transparent bg-muted text-muted-foreground',
      };
  }
}

/** 一个任务所有尝试的收件箱消息，按时间排；worker 发的靠左，主 agent 发的靠右。 */
export function MessageStream({
  view,
  dispatches,
}: {
  view: OrchestrationSnapshotView;
  dispatches: Dispatch[];
}) {
  const t = useT();
  const items = useMemo(() => {
    const list: StreamItem[] = [];
    for (const [index, dispatch] of dispatches.entries()) {
      for (const message of messagesOf(view, dispatch.id)) {
        list.push({ message, dispatch, attempt: index + 1 });
      }
    }
    return list.sort((a, b) => a.message.createdAt - b.message.createdAt);
  }, [view, dispatches]);

  // 还没有答复的提问：worker 正阻塞在 ask_coordinator 上
  const answered = useMemo(() => {
    const ids = new Set<string>();
    for (const { message } of items) {
      if (message.type === 'reply' && message.replyTo) ids.add(message.replyTo);
    }
    return ids;
  }, [items]);

  if (items.length === 0) {
    return <p className="text-muted-foreground text-xs">{t('orchestration.noMessages')}</p>;
  }

  const multiple = dispatches.length > 1;
  return (
    <ol className="flex flex-col gap-2">
      {items.map(({ message, dispatch, attempt }, index) => {
        const separator = multiple && items[index - 1]?.attempt !== attempt;
        return (
          <li key={message.id} className="flex flex-col gap-2">
            {separator && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {t('orchestration.attemptNth', { count: attempt })}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <MessageBubble
              message={message}
              dispatch={dispatch}
              waiting={
                message.type === 'question' &&
                message.ackedAt === undefined &&
                !answered.has(message.id)
              }
            />
          </li>
        );
      })}
    </ol>
  );
}

function MessageBubble({
  message,
  dispatch,
  waiting,
}: {
  message: Message;
  dispatch: Dispatch;
  waiting: boolean;
}) {
  const t = useT();
  const fromWorker = isFromWorker(message, dispatch);
  const { icon: Icon, className } = bubbleStyle(message);
  const subject = describeSubject(message, t);
  const sender = t(fromWorker ? 'orchestration.worker' : 'orchestration.coordinator');
  const type = messageTypeLabel(message.type, t);
  return (
    <div className={cn('flex', fromWorker ? 'justify-start' : 'justify-end')}>
      <article
        aria-label={t('orchestration.bubbleLabel', { sender, type })}
        className={cn('max-w-[90%] rounded-lg border px-2.5 py-1.5 text-xs', className)}
      >
        <header className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
          <Icon className="size-3.5 shrink-0" />
          <span className="font-medium">
            {sender} · {type}
          </span>
          {subject && <span className="text-muted-foreground">{subject}</span>}
          {waiting && (
            <Badge className="border-transparent bg-amber-500/20 px-1 py-0 text-[10px] text-amber-800 dark:text-amber-200">
              {t('orchestration.awaitingReply')}
            </Badge>
          )}
          <time
            className="ml-auto text-muted-foreground tabular-nums"
            dateTime={new Date(message.createdAt).toISOString()}
          >
            {formatClock(message.createdAt)}
          </time>
        </header>
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
      </article>
    </div>
  );
}
