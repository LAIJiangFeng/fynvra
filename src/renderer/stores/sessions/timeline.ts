import { asRecord } from '@shared/guards';
import type { ChatToolCall } from '@shared/types/chat';
import type { TimelineMessage } from './reducer';

// 时间线怎么画（纯函数）：消息投影 → 一行一行；按「通用 → 时间线」的偏好折叠只读工具与历史轮次

const READONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/** read / grep / find / ls：精简显示时单行，连续的合成一条「N 次读取」 */
export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name);
}

/** 值得画出来的消息：没有正文、思考和工具调用的 assistant 占位不画 */
export function isVisibleMessage(message: TimelineMessage): boolean {
  if (message.role === 'user') return true;
  return Boolean(message.text.trim() || message.thinking || message.toolCalls.length > 0);
}

/** 一行里的工具：单个调用，或精简显示时连续的只读调用（`key` 是第一个调用的 id） */
export type ToolItem =
  | { kind: 'call'; call: ChatToolCall }
  | { kind: 'reads'; key: string; calls: ChatToolCall[] };

export type TimelineRow =
  | { kind: 'user'; key: string; message: TimelineMessage }
  /** `message` 带正文 / 思考；它之后只有工具调用的消息并进 `tools` */
  | { kind: 'assistant'; key: string; message: TimelineMessage; tools: ToolItem[] }
  /** 折起来的历史轮次：一行提问 + 时间；`open` 时后面接着整轮内容 */
  | { kind: 'turn'; key: string; message: TimelineMessage; open: boolean };

export interface TimelineRowOptions {
  compactReadonlyTools: boolean;
  foldHistoryTurns: boolean;
  /** 用户手动展开的历史轮次（按提问消息 id） */
  openTurns: ReadonlySet<string>;
}

function groupTools(calls: readonly ChatToolCall[], compact: boolean): ToolItem[] {
  const items: ToolItem[] = [];
  for (const call of calls) {
    const last = items.at(-1);
    if (!compact || !isReadonlyTool(call.name)) items.push({ kind: 'call', call });
    else if (last?.kind === 'reads') last.calls.push(call);
    else items.push({ kind: 'reads', key: call.id, calls: [call] });
  }
  return items;
}

/** 一轮里 assistant 的部分：只有工具调用的消息并进上一行，连续的只读调用才能合在一起 */
function assistantRows(messages: readonly TimelineMessage[], compact: boolean): TimelineRow[] {
  const blocks: { message: TimelineMessage; calls: ChatToolCall[] }[] = [];
  for (const message of messages) {
    const last = blocks.at(-1);
    if (last && !message.text.trim() && !message.thinking) last.calls.push(...message.toolCalls);
    else blocks.push({ message, calls: [...message.toolCalls] });
  }
  return blocks.map(({ message, calls }) => ({
    kind: 'assistant',
    key: message.id,
    message,
    tools: groupTools(calls, compact),
  }));
}

/**
 * 消息投影 → 时间线的行。轮次从每条 user 消息（含乐观回显）开始；折叠历史轮次时，最后一轮之前的每轮
 * 折成一行，用户展开过的接着显示整轮。提问之前的内容（没有提问的开场）不折叠。
 */
export function buildTimelineRows(
  messages: readonly TimelineMessage[],
  options: TimelineRowOptions
): TimelineRow[] {
  const turns: { question?: TimelineMessage; replies: TimelineMessage[] }[] = [];
  for (const message of messages) {
    if (!isVisibleMessage(message)) continue;
    if (message.role === 'user') turns.push({ question: message, replies: [] });
    else if (turns.length === 0) turns.push({ replies: [message] });
    else turns.at(-1)?.replies.push(message);
  }
  const rows: TimelineRow[] = [];
  turns.forEach(({ question, replies }, index) => {
    const body: TimelineRow[] = [
      ...(question ? [{ kind: 'user' as const, key: question.id, message: question }] : []),
      ...assistantRows(replies, options.compactReadonlyTools),
    ];
    const folds = options.foldHistoryTurns && question && index < turns.length - 1;
    if (!folds) {
      rows.push(...body);
      return;
    }
    const open = options.openTurns.has(question.id);
    rows.push({ kind: 'turn', key: `turn-${question.id}`, message: question, open });
    if (open) rows.push(...body);
  });
  return rows;
}

function sameTools(a: readonly ToolItem[], b: readonly ToolItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      if (item.kind === 'call') return other?.kind === 'call' && other.call === item.call;
      return (
        other?.kind === 'reads' &&
        other.calls.length === item.calls.length &&
        other.calls.every((call, at) => call === item.calls[at])
      );
    })
  );
}

function sameRow(a: TimelineRow, b: TimelineRow): boolean {
  if (a.kind !== b.kind || a.message !== b.message) return false;
  if (a.kind === 'turn') return b.kind === 'turn' && a.open === b.open;
  if (a.kind === 'assistant') return b.kind === 'assistant' && sameTools(a.tools, b.tools);
  return true;
}

/**
 * 内容没变的行沿用上一次的对象：流式输出时整张表每批都会重算，按行 memo 的组件只重画变了的那几行。
 */
export function reuseRows(previous: readonly TimelineRow[], next: TimelineRow[]): TimelineRow[] {
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return next.map((row) => {
    const old = byKey.get(row.key);
    return old && sameRow(old, row) ? old : row;
  });
}

/** 折起来的轮次标题行上的提问时间：当天 09:05，其他日子 10-24 23:59，跨年 2025-12-31 08:00 */
export function formatTurnTime(timestamp: number, now: number): string {
  const at = new Date(timestamp);
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  if (at.getFullYear() !== today.getFullYear()) return `${at.getFullYear()}-${day} ${time}`;
  return at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
    ? time
    : `${day} ${time}`;
}

/** 思考块是否展开：手动点过以手动为准；否则开关打开且正在流式思考时展开，结束后收起 */
export function thinkingExpanded(
  userToggled: boolean | null,
  streaming: boolean,
  autoExpand: boolean
): boolean {
  return userToggled ?? (autoExpand && streaming);
}

export interface TextEdit {
  oldText: string;
  newText: string;
}

/** 文件修改工具要展示的内容：edit 的改动，write 写入的全文 */
export type FileChange =
  | { kind: 'edit'; path: string; edits: TextEdit[] }
  | { kind: 'write'; path: string; content: string };

function textEditOf(raw: unknown): TextEdit | null {
  const record = asRecord(raw);
  const { oldText, newText } = record ?? {};
  return typeof oldText === 'string' && typeof newText === 'string' ? { oldText, newText } : null;
}

/**
 * pi 的 edit 参数是 `{ path, edits: [{ oldText, newText }] }`；有的模型把 edits 写成单个对象或 JSON 字符串，
 * 旧格式是顶层 oldText / newText（pi 执行前同样会规整）。读不懂时返回 null，卡片照常显示参数。
 */
export function fileChangeOf(name: string, args: unknown): FileChange | null {
  const record = asRecord(args);
  const path = typeof record?.path === 'string' ? record.path : '';
  if (name === 'write') {
    return typeof record?.content === 'string'
      ? { kind: 'write', path, content: record.content }
      : null;
  }
  if (name !== 'edit' || !record) return null;
  let raw: unknown = record.edits;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const edits = [...entries, record].map(textEditOf);
  // 顶层的 oldText / newText 排在 edits 之后；edits 里有读不懂的一条就整体按读不懂处理
  if (edits.slice(0, entries.length).some((edit) => edit === null)) return null;
  const valid = edits.filter((edit): edit is TextEdit => edit !== null);
  return valid.length > 0 ? { kind: 'edit', path, edits: valid } : null;
}

export interface DiffLine {
  sign: ' ' | '-' | '+';
  text: string;
}

/** 一处替换的行级 diff：首尾相同的行作上下文，中间是删掉与加上的行 */
export function diffEdit({ oldText, newText }: TextEdit): DiffLine[] {
  const before = oldText.split('\n');
  const after = newText.split('\n');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const context = (text: string): DiffLine => ({ sign: ' ', text });
  return [
    ...before.slice(0, head).map(context),
    ...before.slice(head, before.length - tail).map((text): DiffLine => ({ sign: '-', text })),
    ...after.slice(head, after.length - tail).map((text): DiffLine => ({ sign: '+', text })),
    ...before.slice(before.length - tail).map(context),
  ];
}
