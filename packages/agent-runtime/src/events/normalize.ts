import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** tool_end 携带的输出预览长度；完整结果以 pi 会话 jsonl 为准 */
export const TOOL_OUTPUT_PREVIEW_CHARS = 8_000;

/** 归一化后的会话事件（不含 seq）。Renderer 只持有投影，会话正文权威源是 pi jsonl。 */
export type FynvraSessionEventBody =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
      parentToolCallId?: string;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      output: string;
      outputTruncated: boolean;
      durationMs?: number;
      parentToolCallId?: string;
    }
  | {
      type: 'message_end';
      role: 'user' | 'assistant';
      text: string;
      stopReason?: string;
      errorMessage?: string;
    }
  | { type: 'agent_settled'; aborted: boolean }
  | {
      /** pi 没有审批事件：由宿主的审批门（tool_call 拦截）经 emit() 注入 */
      type: 'approval_request';
      requestId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      reason?: string;
    }
  | {
      type: 'usage';
      provider: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      /** 美元，pi 按模型价目计算 */
      cost: number;
    }
  | { type: 'error'; source: 'model' | 'compaction' | 'host'; message: string };

/** 每条事件带递增 seq（从 1 开始）；消费方丢弃过期 seq */
export type FynvraSessionEvent = FynvraSessionEventBody & { seq: number };

export interface NormalizerStats {
  emitted: number;
  /** 未映射（未知类型或无需转发）的 pi 事件数 */
  dropped: number;
  /** 按 pi 事件类型计数；message_update 细分为 `message_update:<子类型>` */
  droppedByType: Record<string, number>;
}

export interface EventNormalizer {
  /** 归一化一条 pi 会话事件：映射为 0..n 条 fynvra 事件；不映射的丢弃并计数。永不抛异常。 */
  push(event: AgentSessionEvent): FynvraSessionEvent[];
  /** 宿主产生的事件（如审批门的 approval_request）进入同一条 seq 序列 */
  emit(event: FynvraSessionEventBody): FynvraSessionEvent;
  stats(): NormalizerStats;
}

export function createEventNormalizer(): EventNormalizer {
  let seq = 0;
  let emitted = 0;
  let dropped = 0;
  const droppedByType: Record<string, number> = {};

  const stamp = (event: FynvraSessionEventBody): FynvraSessionEvent => {
    emitted += 1;
    seq += 1;
    return { ...event, seq };
  };

  return {
    push(event) {
      let bodies: FynvraSessionEventBody[] | undefined;
      try {
        bodies = mapEvent(event);
      } catch {
        // 事件形状与 pi 类型不符（升级复检点）：当作未映射处理，绝不打断 pi 的事件分发
        bodies = undefined;
      }
      if (!bodies || bodies.length === 0) {
        const key = dropKey(event);
        dropped += 1;
        droppedByType[key] = (droppedByType[key] ?? 0) + 1;
        return [];
      }
      return bodies.map(stamp);
    },
    emit: stamp,
    stats: () => ({ emitted, dropped, droppedByType: { ...droppedByType } }),
  };
}

export interface NormalizedSubscription {
  unsubscribe(): void;
  /** 注入宿主事件（approval_request / error 等），与 pi 事件共用 seq */
  emit(event: FynvraSessionEventBody): void;
  stats(): NormalizerStats;
}

export interface SubscribeNormalizedOptions {
  /** listener 抛出的异常；默认吞掉，因为 pi 在事件分发之后才持久化消息 */
  onListenerError?: (error: unknown) => void;
}

/** 订阅 pi 会话并把事件归一化后交给 listener */
export function subscribeNormalized(
  session: Pick<AgentSession, 'subscribe'>,
  listener: (event: FynvraSessionEvent) => void,
  options: SubscribeNormalizedOptions = {}
): NormalizedSubscription {
  const normalizer = createEventNormalizer();
  const deliver = (event: FynvraSessionEvent) => {
    try {
      listener(event);
    } catch (error) {
      // pi 的 _emit 不隔离 listener 异常，抛出去会跳过 message_end 之后的 jsonl 持久化
      options.onListenerError?.(error);
    }
  };
  const unsubscribe = session.subscribe((event) => {
    for (const normalized of normalizer.push(event)) deliver(normalized);
  });
  return {
    unsubscribe,
    emit: (event) => deliver(normalizer.emit(event)),
    stats: () => normalizer.stats(),
  };
}

function mapEvent(event: AgentSessionEvent): FynvraSessionEventBody[] | undefined {
  switch (event.type) {
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') return [{ type: 'text_delta', delta: update.delta }];
      if (update.type === 'thinking_delta')
        return [{ type: 'thinking_delta', delta: update.delta }];
      return undefined;
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      ];
    case 'tool_execution_end': {
      const output = toolOutputText(event.result);
      return [
        {
          type: 'tool_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          output: output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS),
          outputTruncated: output.length > TOOL_OUTPUT_PREVIEW_CHARS,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      ];
    }
    case 'message_end':
      return mapMessageEnd(event.message);
    case 'agent_end': {
      // 会自动重试的失败不算错误；只报告最终失败
      if (event.willRetry) return undefined;
      const last = lastAssistant(event.messages);
      if (last?.stopReason !== 'error') return undefined;
      return [
        { type: 'error', source: 'model', message: last.errorMessage || 'model request failed' },
      ];
    }
    case 'compaction_end':
      return event.errorMessage && !event.willRetry && !event.aborted
        ? [{ type: 'error', source: 'compaction', message: event.errorMessage }]
        : undefined;
    case 'agent_settled':
      return [{ type: 'agent_settled', aborted: event.aborted }];
    default:
      return undefined;
  }
}

function mapMessageEnd(message: AgentMessage): FynvraSessionEventBody[] | undefined {
  if (message.role === 'user') {
    return [{ type: 'message_end', role: 'user', text: textOf(message.content) }];
  }
  if (message.role !== 'assistant') return undefined;
  const events: FynvraSessionEventBody[] = [
    {
      type: 'message_end',
      role: 'assistant',
      text: textOf(message.content),
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    },
  ];
  const usage = message.usage;
  if (usage && usage.totalTokens > 0) {
    events.push({
      type: 'usage',
      provider: message.provider,
      model: message.model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      cost: usage.cost?.total ?? 0,
    });
  }
  return events;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

/** 只取 text 块（不含 thinking / toolCall） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : ''
    )
    .join('');
}

function toolOutputText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return part?.type === 'image' ? '[image]' : '';
    })
    .join('');
}

function dropKey(event: unknown): string {
  const type = (event as { type?: unknown } | null)?.type;
  if (typeof type !== 'string') return 'unknown';
  if (type !== 'message_update') return type;
  const sub = (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent?.type;
  return typeof sub === 'string' ? `message_update:${sub}` : type;
}
