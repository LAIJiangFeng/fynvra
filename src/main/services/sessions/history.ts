import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import {
  type ChatImage,
  type ChatMessage,
  type ChatToolCall,
  type ContextRecoveryHint,
  isChatImageMimeType,
  stripImageHints,
} from '@shared/types/chat';

/**
 * 工具输出在投影里保留的长度，与 agent-runtime 的 TOOL_OUTPUT_PREVIEW_CHARS 相同。
 * Main 不 import agent-runtime 的值：那会把 pi 整个带进主进程。
 */
export const HISTORY_TOOL_OUTPUT_CHARS = 8_000;

/** pi 会话 jsonl 的位置：`<agentDir>/sessions/<sessionId>.jsonl`（由 Main 决定，经 spawn-session 交给 worker） */
export function sessionFilePath(agentDir: string, sessionId: string): string {
  return join(agentDir, 'sessions', `${sessionId}.jsonl`);
}

export interface ProjectHistoryOptions {
  /** 会话正在运行：最后一条消息里还没有结果的工具调用算 running，否则按被中断算 error */
  running?: boolean;
}

export interface HistoryProjection {
  messages: ChatMessage[];
  contextRecovery?: ContextRecoveryHint;
}

/** 读 jsonl 并投影；文件还不存在（会话还没有消息）时返回空列表 */
export async function readHistory(
  file: string,
  sessionId: string,
  options: ProjectHistoryOptions = {}
): Promise<ChatMessage[]> {
  return (await readHistoryProjection(file, sessionId, options)).messages;
}

/** One read projects both messages and the read-only recovery hint from the same branch. */
export async function readHistoryProjection(
  file: string,
  sessionId: string,
  options: ProjectHistoryOptions = {}
): Promise<HistoryProjection> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [] };
    throw error;
  }
  return projectHistoryProjection(text, sessionId, options);
}

interface Entry {
  type: string;
  id: string;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * pi jsonl（权威源）→ Renderer 的 ChatMessage[] 投影。
 * 只走当前分支（从最后一条条目沿 parentId 回到根），不是文件里的每一行；
 * user / assistant 各成一条消息，toolResult 回填到发起它的工具调用上，其余条目（system、模型切换、标签等）跳过。
 * user 消息带上它的图片；带图片的，正文去掉 pi 规整图片时接在末尾的提示行。
 * 读不懂的行直接忽略，永不抛异常。
 */
export function projectHistory(
  jsonl: string,
  sessionId: string,
  options: ProjectHistoryOptions = {}
): ChatMessage[] {
  return projectHistoryProjection(jsonl, sessionId, options).messages;
}

export function projectHistoryProjection(
  jsonl: string,
  sessionId: string,
  options: ProjectHistoryOptions = {}
): HistoryProjection {
  const messages: ChatMessage[] = [];
  let contextRecovery: ContextRecoveryHint | undefined;
  const calls = new Map<string, ChatToolCall>();
  for (const entry of currentBranch(parseEntries(jsonl))) {
    if (entry.type === 'custom' && entry.customType === 'fynvra-context-recovery') {
      const data = asRecord(entry.data);
      // Match the runtime checkpoint validity gate, exposing neither input bodies nor engine data.
      if (data && typeof data.blocked === 'boolean' && Array.isArray(data.pending)) {
        contextRecovery = { recoveryRequired: data.blocked };
      }
    }
    const message = entry.type === 'message' ? asRecord(entry.message) : null;
    if (!message) continue;
    const base = {
      id: entry.id,
      sessionId,
      createdAt: timestampOf(message, entry),
      streaming: false,
    };
    if (message.role === 'user') {
      const images = imagesOf(message.content);
      const text = textOf(message.content);
      messages.push({
        ...base,
        role: 'user',
        ...(images.length > 0 ? { text: stripImageHints(text), images } : { text }),
        toolCalls: [],
      });
    } else if (message.role === 'assistant') {
      const toolCalls = toolCallsOf(message.content);
      for (const call of toolCalls) calls.set(call.id, call);
      const thinking = thinkingOf(message.content);
      const usage = usageOf(message.usage);
      messages.push({
        ...base,
        role: 'assistant',
        text: textOf(message.content),
        ...(thinking ? { thinking } : {}),
        toolCalls,
        ...(usage ? { usage } : {}),
      });
    } else if (message.role === 'toolResult') {
      const call = calls.get(String(message.toolCallId));
      if (!call) continue;
      call.status = message.isError === true ? 'error' : 'done';
      call.output = textOf(message.content).slice(0, HISTORY_TOOL_OUTPUT_CHARS);
      if (typeof message.durationMs === 'number' && Number.isFinite(message.durationMs)) {
        call.durationMs = message.durationMs;
      }
    }
  }
  const last = messages.at(-1);
  for (const message of messages) {
    if (options.running && message === last) continue;
    for (const call of message.toolCalls) {
      if (call.status === 'running') call.status = 'error';
    }
  }
  return { messages, ...(contextRecovery ? { contextRecovery } : {}) };
}

function parseEntries(jsonl: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record || typeof record.type !== 'string' || record.type === 'session') continue;
    if (typeof record.id !== 'string') continue;
    entries.push(record as unknown as Entry);
  }
  return entries;
}

/** 从最后一条条目沿 parentId 回到根；没有树结构的旧文件按文件顺序 */
function currentBranch(entries: Entry[]): Entry[] {
  const leaf = entries.at(-1);
  if (!leaf) return [];
  if (!('parentId' in leaf)) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Entry[] = [];
  const seen = new Set<string>();
  let node: Entry | undefined = leaf;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.push(node);
    node = typeof node.parentId === 'string' ? byId.get(node.parentId) : undefined;
  }
  return path.reverse();
}

function timestampOf(message: Record<string, unknown>, entry: Entry): number {
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block) => block !== null);
}

/** 只取 text 块（与归一化事件 message_end 的 text 一致） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** image 块（格式在白名单里、data 是字符串）；pi 存的是它规整后的图片 */
function imagesOf(content: unknown): ChatImage[] {
  return blocksOf(content).flatMap(({ type, data, mimeType }): ChatImage[] =>
    type === 'image' && typeof data === 'string' && isChatImageMimeType(mimeType)
      ? [{ data, mimeType }]
      : []
  );
}

function thinkingOf(content: unknown): string {
  return blocksOf(content)
    .map((block) =>
      block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''
    )
    .join('');
}

function toolCallsOf(content: unknown): ChatToolCall[] {
  return blocksOf(content).flatMap((block): ChatToolCall[] =>
    block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name, args: block.arguments ?? {}, status: 'running' }]
      : []
  );
}

function usageOf(raw: unknown): ChatMessage['usage'] {
  const usage = asRecord(raw);
  if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') {
    return undefined;
  }
  const cost = asRecord(usage.cost)?.total;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  };
}
