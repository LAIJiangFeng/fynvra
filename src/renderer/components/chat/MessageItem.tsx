import { memo, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { selectCompactingOf, type TimelineMessage, useSessionsStore } from '@/stores/sessions';
import type { ToolItem } from '@/stores/sessions/timeline';
import { ChatMarkdown } from './ChatMarkdown';
import { CopyButton } from './CopyButton';
import { ImagePreview } from './ImagePreview';
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

/** 用户的消息：粘贴的图片画在气泡上方（右对齐），正文为空（只有图片）时不画气泡 */
function UserMessage({ message }: { message: TimelineMessage }) {
  const t = useT();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const sending = message.optimistic && !message.failed;
  return (
    <div className="flex flex-col items-end gap-1">
      {message.images?.map((image, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: 消息里的图片没有 id，也不会重排
          key={index}
          type="button"
          aria-label={t('chat.previewImage', { index: index + 1 })}
          onClick={() => setPreviewIndex(index)}
          className="max-w-full rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={t('chat.image', { index: index + 1 })}
            className={cn(
              'max-h-48 max-w-full rounded-lg border object-contain',
              sending && 'opacity-70',
              message.failed && 'border-destructive/50'
            )}
          />
        </button>
      ))}
      {message.images && (
        <ImagePreview
          images={message.images}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
        />
      )}
      {message.text.trim() && (
        <div
          className={cn(
            'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-secondary px-4 py-2 text-secondary-foreground text-sm',
            sending && 'opacity-70',
            message.failed && 'border border-destructive/50'
          )}
        >
          {message.text}
        </div>
      )}
      {message.optimistic && <PendingDelivery message={message} />}
    </div>
  );
}

function PendingDelivery({ message }: { message: TimelineMessage }) {
  const compacting = useSessionsStore(selectCompactingOf(message.sessionId));
  const pending = useSessionsStore(
    (state) => state.runtimeBySession[message.sessionId]?.pendingPromptCount ?? 0
  );
  const recovery = useSessionsStore(
    (state) => state.runtimeBySession[message.sessionId]?.recoveryRequired
  );
  const t = useT();
  const key = compacting
    ? 'chat.queuedForCompaction'
    : pending > 0 && recovery
      ? 'chat.pendingForRecovery'
      : pending > 0
        ? 'chat.acceptedPending'
        : message.failed
          ? 'chat.undelivered'
          : 'chat.sending';
  return (
    <span
      className={cn(
        'text-xs',
        message.failed && pending === 0 ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {t(key)}
    </span>
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
      {text && <ChatMarkdown sessionId={message.sessionId} text={text} streaming={streaming} />}
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
