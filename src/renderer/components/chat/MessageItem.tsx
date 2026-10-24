import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { TimelineMessage } from '@/stores/sessions';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';

/** 值得画出来的消息：没有正文、思考和工具调用的 assistant 占位不画。 */
export function isVisibleMessage(message: TimelineMessage): boolean {
  if (message.role === 'user') return true;
  return Boolean(message.text.trim() || message.thinking || message.toolCalls.length > 0);
}

export const MessageItem = memo(function MessageItem({ message }: { message: TimelineMessage }) {
  return message.role === 'user' ? (
    <UserMessage message={message} />
  ) : (
    <AssistantMessage message={message} />
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

function AssistantMessage({ message }: { message: TimelineMessage }) {
  const { text, thinking, toolCalls, streaming } = message;
  return (
    <div className="group/assistant min-w-0 space-y-2">
      {thinking && <ThinkingBlock text={thinking} active={streaming && !text} />}
      {text && <Markdown text={text} streaming={streaming} />}
      {toolCalls.length > 0 && (
        <div className="space-y-1.5">
          {toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
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
