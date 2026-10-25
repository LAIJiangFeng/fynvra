import { memo } from 'react';
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
 */
export const MessageItem = memo(function MessageItem({
  message,
  tools,
}: {
  message: TimelineMessage;
  tools?: ToolItem[];
}) {
  return message.role === 'user' ? (
    <UserMessage message={message} />
  ) : (
    <AssistantMessage message={message} tools={tools} />
  );
});

function UserMessage({ message }: { message: TimelineMessage }) {
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
          {message.failed ? '未送达' : '发送中…'}
        </span>
      )}
    </div>
  );
}

function AssistantMessage({ message, tools }: { message: TimelineMessage; tools?: ToolItem[] }) {
  const { text, thinking, streaming } = message;
  const items = tools ?? message.toolCalls.map((call): ToolItem => ({ kind: 'call', call }));
  return (
    <div className="group/assistant min-w-0 space-y-2">
      {thinking && <ThinkingBlock text={thinking} active={streaming && !text} />}
      {text && <Markdown text={text} streaming={streaming} />}
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item) =>
            item.kind === 'call' ? (
              <ToolCallCard key={item.call.id} call={item.call} />
            ) : (
              <ReadonlyTools key={item.key} calls={item.calls} />
            )
          )}
        </div>
      )}
      {text && !streaming && (
        <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/assistant:opacity-100">
          <CopyButton text={text} label="复制回复" />
        </div>
      )}
    </div>
  );
}
