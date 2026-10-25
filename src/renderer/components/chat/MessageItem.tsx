import { memo } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import type { TimelineMessage } from '@/stores/sessions';
import type { ToolItem } from '@/stores/sessions/timeline';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ReadonlyTools, ToolCallCard } from './ToolCallCard';

/**
 * 一条消息。assistant 的工具调用由时间线分好组传进来（`tools`：连续的只读调用可能合成一组，
 * 后面只有工具调用的消息也并在这里）；不传时按消息自己的工具调用逐个画卡片。
 * `live`：消息属于正在跑的这一轮（文件修改卡片按设置自动展开）。
 */
export const MessageItem = memo(function MessageItem({
  message,
  tools,
  live = false,
}: {
  message: TimelineMessage;
  tools?: ToolItem[];
  live?: boolean;
}) {
  return message.role === 'user' ? (
    <UserMessage message={message} />
  ) : (
    <AssistantMessage message={message} tools={tools} live={live} />
  );
});

function UserMessage({ message }: { message: TimelineMessage }) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-secondary px-4 py-2 text-secondary-foreground text-sm',
          message.optimistic && !message.failed && 'opacity-70',
          message.failed && 'border border-destructive/50'
        )}
      >
        {message.text}
      </div>
      {message.optimistic && (
        <span
          className={cn('text-xs', message.failed ? 'text-destructive' : 'text-muted-foreground')}
        >
          {t(message.failed ? 'chat.undelivered' : 'chat.sending')}
        </span>
      )}
    </div>
  );
}

function AssistantMessage({
  message,
  tools,
  live,
}: {
  message: TimelineMessage;
  tools?: ToolItem[];
  live: boolean;
}) {
  const { text, thinking, streaming } = message;
  const t = useT();
  const items = tools ?? message.toolCalls.map((call): ToolItem => ({ kind: 'call', call }));
  return (
    <div className="group/assistant min-w-0 space-y-2">
      {thinking && <ThinkingBlock text={thinking} active={streaming && !text} />}
      {text && <Markdown text={text} streaming={streaming} />}
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item) =>
            item.kind === 'call' ? (
              <ToolCallCard key={item.call.id} call={item.call} live={live} />
            ) : (
              <ReadonlyTools key={item.key} calls={item.calls} />
            )
          )}
        </div>
      )}
      {text && !streaming && (
        <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/assistant:opacity-100">
          <CopyButton text={text} label={t('chat.copyReply')} />
        </div>
      )}
    </div>
  );
}
