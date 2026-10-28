import type { FynvraSessionEvent } from '@fynvra/core';
import {
  type ApprovalRequest,
  type ChatImage,
  type ChatMessage,
  type ChatToolCall,
  type SessionEventEnvelope,
  type SessionStatus,
  type SessionSummary,
  stripImageHints,
} from '@shared/types/chat';

type SessionWarning = 'magic-context';

/**
 * 时间线消息。乐观回显（本地先上屏、还没等到 user 的 message_end）带 `optimistic`，
 * 只允许出现在数组尾部；回合开始前就失败的回显再加 `failed`。
 */
export interface TimelineMessage extends ChatMessage {
  optimistic?: true;
  failed?: true;
}

/** 兼容旧 store 类型；新版不会生成可操作审批。 */
export interface PendingApproval extends ApprovalRequest {
  toolCallId?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** 由事件推导、`SessionSummary` 之外的会话运行态。 */
export interface SessionRuntime {
  /** 已处理的最大 seq：小于等于它的事件一律丢弃。 */
  lastSeq: number;
  /** Latest event affecting suggestion validity; warnings only advance lastSeq. */
  activitySeq?: number;
  status: SessionStatus;
  /** 会话累计用量；history 回放时按权威消息重算。 */
  usage: UsageTotals;
  /** 最近一次 usage 事件里的模型 id。 */
  model?: string;
  /** 本轮的错误，新一轮开始时清除；settled 时据此决定 idle 还是 error。 */
  error?: string;
  /** 非阻塞服务告警（如 Magic Context 已交回原生压缩）；不影响 status / error。 */
  warning?: SessionWarning;
  warningSeq?: number;
  dismissedWarningSeq?: number;
  /** 最近一次正常结束（非 aborted）的 settled 事件的会话级 seq：回复建议只对这一轮有效 */
  settledSeq?: number;
  /** 运行中工具的本地开始时间（toolCallId → epoch ms），tool_end 缺 durationMs 时据此推算。 */
  toolStartedAt: Record<string, number>;
}

/** 会话正文投影：全部按 sessionId 分桶。 */
export interface ChatProjection {
  messagesBySession: Record<string, TimelineMessage[]>;
  runtimeBySession: Record<string, SessionRuntime>;
  /** 兼容旧投影形状，始终为空；旧审批事件不能重新入队。 */
  pendingApprovals: Record<string, PendingApproval[]>;
}

const EMPTY_MESSAGES: TimelineMessage[] = [];
const EMPTY_APPROVALS: PendingApproval[] = [];
const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function emptyProjection(): ChatProjection {
  return { messagesBySession: {}, runtimeBySession: {}, pendingApprovals: {} };
}

function emptyRuntime(): SessionRuntime {
  return { lastSeq: 0, status: 'idle', usage: NO_USAGE, toolStartedAt: {} };
}

/** 单个会话的工作副本：事件处理只改这三样。 */
interface Slice {
  messages: TimelineMessage[];
  runtime: SessionRuntime;
  approvals: PendingApproval[];
}

function sliceOf(state: ChatProjection, sessionId: string): Slice {
  return {
    messages: state.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
    runtime: state.runtimeBySession[sessionId] ?? emptyRuntime(),
    approvals: state.pendingApprovals[sessionId] ?? EMPTY_APPROVALS,
  };
}

function commit<S extends ChatProjection>(
  state: S,
  sessionId: string,
  before: Slice,
  after: Slice
): S {
  return {
    ...state,
    messagesBySession:
      after.messages === before.messages
        ? state.messagesBySession
        : { ...state.messagesBySession, [sessionId]: after.messages },
    runtimeBySession:
      after.runtime === before.runtime && state.runtimeBySession[sessionId]
        ? state.runtimeBySession
        : { ...state.runtimeBySession, [sessionId]: after.runtime },
    pendingApprovals:
      after.approvals === before.approvals
        ? state.pendingApprovals
        : { ...state.pendingApprovals, [sessionId]: after.approvals },
  };
}

/**
 * 把一条 Main 推送的会话事件归并进投影。纯函数；`now` 只用于新消息的时间戳与工具耗时推算。
 * `seq` 小于等于已处理值的事件丢弃并原样返回 `state`。
 */
export function reduceSessionEvent<S extends ChatProjection>(
  state: S,
  envelope: SessionEventEnvelope,
  now: number = Date.now()
): S {
  const { sessionId, event } = envelope;
  const before = sliceOf(state, sessionId);
  if (event.seq <= before.runtime.lastSeq) return state;
  const current: Slice = {
    ...before,
    runtime: {
      ...before.runtime,
      lastSeq: event.seq,
      activitySeq:
        event.type === 'warning'
          ? (before.runtime.activitySeq ?? before.runtime.lastSeq)
          : event.seq,
    },
  };
  return commit(state, sessionId, before, applyEvent(current, sessionId, event, now));
}

function applyEvent(
  slice: Slice,
  sessionId: string,
  event: FynvraSessionEvent,
  now: number
): Slice {
  const fresh = { id: `live-${event.seq}`, sessionId, createdAt: now };
  switch (event.type) {
    case 'text_delta':
      return active(
        updateStreaming(slice, fresh, (message) => ({
          ...message,
          text: message.text + event.delta,
        }))
      );
    case 'thinking_delta':
      return active(
        updateStreaming(slice, fresh, (message) => ({
          ...message,
          thinking: (message.thinking ?? '') + event.delta,
        }))
      );
    case 'message_end':
      return event.role === 'user'
        ? startTurn(confirmUser(slice, fresh, event.text))
        : active(finishAssistant(slice, fresh, event.text));
    case 'tool_start': {
      const next = upsertToolCall(slice, fresh, event.toolCallId, () => ({
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running',
      }));
      return active({
        ...withoutApprovalsFor(next, event.toolCallId),
        runtime: {
          ...next.runtime,
          toolStartedAt: { ...next.runtime.toolStartedAt, [event.toolCallId]: now },
        },
      });
    }
    case 'tool_end': {
      const startedAt = slice.runtime.toolStartedAt[event.toolCallId];
      const durationMs =
        event.durationMs ?? (startedAt === undefined ? undefined : Math.max(0, now - startedAt));
      const next = upsertToolCall(slice, fresh, event.toolCallId, (call) => ({
        id: event.toolCallId,
        name: call?.name ?? event.toolName,
        args: call?.args,
        status: event.isError ? 'error' : 'done',
        output: event.output,
        ...(durationMs === undefined ? {} : { durationMs }),
      }));
      const { [event.toolCallId]: _ended, ...toolStartedAt } = next.runtime.toolStartedAt;
      return active({
        ...withoutApprovalsFor(next, event.toolCallId),
        runtime: { ...next.runtime, toolStartedAt },
      });
    }
    case 'usage': {
      const usage = { inputTokens: event.input, outputTokens: event.output, costUsd: event.cost };
      const index = lastIndexOf(slice.messages, authoritativeLength(slice.messages), isAssistant);
      return {
        ...slice,
        messages:
          index < 0
            ? slice.messages
            : replaceAt(slice.messages, index, { ...slice.messages[index], usage }),
        runtime: {
          ...slice.runtime,
          usage: addUsage(slice.runtime.usage, usage),
          model: event.model,
        },
      };
    }
    case 'approval_request':
      return retireApprovals(slice);
    case 'tool_notice':
      // 只用于旁路通知；不能据此把工具标为开始或成功。
      return slice;
    case 'agent_settled':
      return {
        messages: settleMessages(slice.messages),
        runtime: {
          ...slice.runtime,
          status: slice.runtime.error === undefined ? 'idle' : 'error',
          toolStartedAt: {},
          ...(event.aborted ? {} : { settledSeq: event.seq }),
        },
        approvals: EMPTY_APPROVALS,
      };
    case 'error':
      return {
        ...slice,
        // 还没等到 user 的 message_end 就出错：这些回显不会再被确认
        messages: slice.messages.map((message) =>
          message.optimistic && !message.failed ? { ...message, failed: true } : message
        ),
        runtime: { ...slice.runtime, status: 'error', error: event.message },
      };
    case 'warning':
      return {
        ...slice,
        runtime: { ...slice.runtime, warning: event.source, warningSeq: event.seq },
      };
    default:
      return slice;
  }
}

/** 真实流式 / 工具事件表明正在运行，不再由审批队列推导等待态。 */
function active(slice: Slice): Slice {
  return {
    ...slice,
    approvals: EMPTY_APPROVALS,
    runtime:
      slice.runtime.status === 'running' ? slice.runtime : { ...slice.runtime, status: 'running' },
  };
}

/** 忽略旧审批：仅按已有实时投影恢复状态，不重放动作或伪造完成。 */
function retireApprovals(slice: Slice): Slice {
  const running =
    Object.keys(slice.runtime.toolStartedAt).length > 0 ||
    slice.messages.some((message) => message.streaming || message.optimistic);
  return {
    ...slice,
    approvals: EMPTY_APPROVALS,
    runtime:
      slice.runtime.status === 'waiting-approval'
        ? { ...slice.runtime, status: slice.runtime.error ? 'error' : running ? 'running' : 'idle' }
        : slice.runtime,
  };
}

/** 新一轮开始：清掉上一轮的错误。 */
function startTurn(slice: Slice): Slice {
  const next = active(slice);
  return { ...next, runtime: { ...next.runtime, error: undefined } };
}

/** 乐观回显之前的消息数（权威区长度）。 */
function authoritativeLength(messages: readonly TimelineMessage[]): number {
  const index = messages.findIndex((message) => message.optimistic);
  return index < 0 ? messages.length : index;
}

const isAssistant = (message: TimelineMessage) => message.role === 'assistant';

function lastIndexOf(
  messages: readonly TimelineMessage[],
  end: number,
  predicate: (message: TimelineMessage) => boolean
): number {
  for (let index = end - 1; index >= 0; index--) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items];
  next[index] = item;
  return next;
}

function insertAt<T>(items: readonly T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

interface Fresh {
  id: string;
  sessionId: string;
  createdAt: number;
}

function newMessage(
  fresh: Fresh,
  role: ChatMessage['role'],
  text: string,
  streaming: boolean
): TimelineMessage {
  return { ...fresh, role, text, toolCalls: [], streaming };
}

/** 对权威区末尾的流式 assistant 消息做增量；没有就在乐观回显之前新建一条。 */
function updateStreaming(
  slice: Slice,
  fresh: Fresh,
  update: (message: TimelineMessage) => TimelineMessage
): Slice {
  const end = authoritativeLength(slice.messages);
  const last = slice.messages[end - 1];
  if (last?.role === 'assistant' && last.streaming) {
    return { ...slice, messages: replaceAt(slice.messages, end - 1, update(last)) };
  }
  const created = update(newMessage(fresh, 'assistant', '', true));
  return { ...slice, messages: insertAt(slice.messages, end, created) };
}

/** assistant 的 message_end：权威正文整条替换流式消息；没有流式消息时落一条新的。 */
function finishAssistant(slice: Slice, fresh: Fresh, text: string): Slice {
  const end = authoritativeLength(slice.messages);
  const last = slice.messages[end - 1];
  if (last?.role === 'assistant' && last.streaming) {
    return {
      ...slice,
      messages: replaceAt(slice.messages, end - 1, { ...last, text, streaming: false }),
    };
  }
  return {
    ...slice,
    messages: insertAt(slice.messages, end, newMessage(fresh, 'assistant', text, false)),
  };
}

/**
 * user 的 message_end：确认最早的乐观回显（原位、去掉标记，图片留着）；没有回显就追加一条。
 * 带图片的回显，正文取去掉 pi 提示行后的文本（事件里不带图片）。
 */
function confirmUser(slice: Slice, fresh: Fresh, text: string): Slice {
  const index = slice.messages.findIndex((message) => message.optimistic);
  if (index < 0) {
    return { ...slice, messages: [...slice.messages, newMessage(fresh, 'user', text, false)] };
  }
  const { optimistic: _optimistic, failed: _failed, ...confirmed } = slice.messages[index];
  const delivered = confirmed.images ? stripImageHints(text) : text;
  return {
    ...slice,
    messages: replaceAt(slice.messages, index, { ...confirmed, text: delivered }),
  };
}

/**
 * history 里的 user 消息是不是这条回显送达后的样子。投影里带图片的已去掉 pi 的提示行，
 * 图片都被 pi 略去的没有图片、正文还带着提示行；pi 存的是规整后的图片，所以只比正文。
 */
function deliveredAs(echo: TimelineMessage, message: ChatMessage): boolean {
  if (message.text === echo.text) return true;
  return echo.images !== undefined && stripImageHints(message.text) === echo.text;
}

/**
 * 按 id 更新工具调用（history 里已有的原位更新）；找不到就挂到权威区最近的 assistant 消息上，
 * 连 assistant 消息都没有时补一条空的。
 */
function upsertToolCall(
  slice: Slice,
  fresh: Fresh,
  toolCallId: string,
  build: (existing: ChatToolCall | undefined) => ChatToolCall
): Slice {
  const owner = lastIndexOf(slice.messages, slice.messages.length, (message) =>
    message.toolCalls.some((call) => call.id === toolCallId)
  );
  if (owner >= 0) {
    const message = slice.messages[owner];
    const toolCalls = message.toolCalls.map((call) =>
      call.id === toolCallId ? build(call) : call
    );
    return { ...slice, messages: replaceAt(slice.messages, owner, { ...message, toolCalls }) };
  }
  const end = authoritativeLength(slice.messages);
  const host = lastIndexOf(slice.messages, end, isAssistant);
  if (host < 0) {
    const created = { ...newMessage(fresh, 'assistant', '', false), toolCalls: [build(undefined)] };
    return { ...slice, messages: insertAt(slice.messages, end, created) };
  }
  const message = slice.messages[host];
  return {
    ...slice,
    messages: replaceAt(slice.messages, host, {
      ...message,
      toolCalls: [...message.toolCalls, build(undefined)],
    }),
  };
}

/** 回合结束：流式消息收尾，等不到结果的工具调用按中断处理。 */
function settleMessages(messages: TimelineMessage[]): TimelineMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const interrupted = message.toolCalls.some((call) => call.status === 'running');
    if (!message.streaming && !interrupted) return message;
    changed = true;
    return {
      ...message,
      streaming: false,
      toolCalls: interrupted
        ? message.toolCalls.map((call) =>
            call.status === 'running' ? { ...call, status: 'error' as const } : call
          )
        : message.toolCalls,
    };
  });
  return changed ? next : messages;
}

function withoutApprovalsFor(slice: Slice, toolCallId: string): Slice {
  const approvals = slice.approvals.filter((request) => request.toolCallId !== toolCallId);
  return approvals.length === slice.approvals.length ? slice : { ...slice, approvals };
}

function addUsage(total: UsageTotals, usage: ChatMessage['usage']): UsageTotals {
  if (!usage) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    costUsd: total.costUsd + (usage.costUsd ?? 0),
  };
}

/**
 * 发送时的乐观回显（带着粘贴的图片）：追加在末尾，会话置 running 并清掉上一轮的错误和未送达的回显。
 */
export function addOptimisticMessage<S extends ChatProjection>(
  state: S,
  sessionId: string,
  input: { id: string; text: string; images?: readonly ChatImage[]; createdAt: number }
): S {
  const before = sliceOf(state, sessionId);
  const { id, text, images, createdAt } = input;
  const echo: TimelineMessage = {
    ...newMessage({ id, sessionId, createdAt }, 'user', text, false),
    ...(images?.length ? { images: [...images] } : {}),
    optimistic: true,
  };
  const after = startTurn({
    ...before,
    messages: [...before.messages.filter((message) => !message.failed), echo],
  });
  return commit(state, sessionId, before, after);
}

/** prompt 调用失败：撤回这条回显，恢复发送前的状态并记下错误。 */
export function withdrawOptimisticMessage<S extends ChatProjection>(
  state: S,
  sessionId: string,
  messageId: string,
  restore: { status: SessionStatus; error: string }
): S {
  const before = sliceOf(state, sessionId);
  return commit(state, sessionId, before, {
    ...before,
    messages: before.messages.filter((message) => message.id !== messageId),
    runtime: { ...before.runtime, status: restore.status, error: restore.error },
  });
}

/**
 * history 回放：用权威投影整体替换。还没落盘的内容（权威区末尾的流式消息、未确认的乐观回显）
 * 留在尾部；history 里出现了本地还没见过的同文 user 消息时，对应的回显视为已送达（见 deliveredAs）。
 */
export function applyHistory<S extends ChatProjection>(
  state: S,
  sessionId: string,
  history: readonly ChatMessage[]
): S {
  const before = sliceOf(state, sessionId);
  const end = authoritativeLength(before.messages);
  const last = before.messages[end - 1];
  const streaming = last?.role === 'assistant' && last.streaming ? [last] : [];

  const seenUsers = before.messages.slice(0, end).filter((message) => message.role === 'user');
  const unseen = history.filter((message) => message.role === 'user').slice(seenUsers.length);
  const echoes = before.messages.slice(end).filter((echo) => {
    const delivered = unseen.findIndex((message) => deliveredAs(echo, message));
    if (delivered < 0) return true;
    unseen.splice(delivered, 1);
    return false;
  });

  return commit(state, sessionId, before, {
    ...before,
    messages: [...history, ...streaming, ...echoes],
    runtime: {
      ...before.runtime,
      usage: history.reduce((total, message) => addUsage(total, message.usage), NO_USAGE),
    },
  });
}

/** @deprecated 旧 IPC 只清理旧投影，不创建人工等待。 */
export function enqueueApproval<S extends ChatProjection>(state: S, request: ApprovalRequest): S {
  const before = sliceOf(state, request.sessionId);
  return commit(state, request.sessionId, before, retireApprovals(before));
}

/** @deprecated 清理旧审批投影；答复不能使工具进入运行态。 */
export function dequeueApproval<S extends ChatProjection>(
  state: S,
  sessionId: string,
  requestId: string
): S {
  const before = sliceOf(state, sessionId);
  const approvals = before.approvals.filter((request) => request.id !== requestId);
  if (approvals.length === before.approvals.length) return state;
  return commit(state, sessionId, before, retireApprovals({ ...before, approvals }));
}

/**
 * 会话列表刷新：已有投影的会话以 Main 的状态为准（Main 每次改状态都会广播 sessions:changed）。
 * `skip` 里的会话（prompt 调用还在途）保留本地的乐观状态。
 */
export function syncSessionStatuses<S extends ChatProjection>(
  state: S,
  sessions: readonly Pick<SessionSummary, 'id' | 'status'>[],
  skip: ReadonlySet<string>
): S {
  let runtimeBySession: Record<string, SessionRuntime> | undefined;
  for (const session of sessions) {
    const runtime = state.runtimeBySession[session.id];
    if (!runtime || skip.has(session.id)) continue;
    const status =
      session.status === 'waiting-approval'
        ? retireApprovals(sliceOf(state, session.id)).runtime.status
        : session.status;
    if (runtime.status === status) continue;
    runtimeBySession ??= { ...state.runtimeBySession };
    runtimeBySession[session.id] = { ...runtime, status };
  }
  return runtimeBySession ? { ...state, runtimeBySession } : state;
}
