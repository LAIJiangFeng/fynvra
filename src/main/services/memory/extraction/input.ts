import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ChatMessage, splitChatFiles } from '@shared/types/chat';
import type { AcceptedDispatch, AcceptedTask } from '../../orchestration/service';
import type { MemoryRow } from '../store';

// 验收提炼的输入材料（ARCHITECTURE §7.15「验收提炼 · 输入 / 摘录规则」）：除读上下文文件外都是纯函数。

/** 各项预算（字符） */
export const BUDGET = {
  task: 3000,
  taskHead: 2400,
  files: 50,
  diffStat: 1500,
  report: 2000,
  feedback: 3000,
  excerpt: 12000,
  contextFile: 3000,
  candidates: 20,
} as const;

const MCP_OUTPUT_MAX = 1000;
const TOOL_ERROR_MAX = 300;
const TOOL_ARGS_MAX = 200;
const WEB_MARKER = 'BEGIN UNTRUSTED WEB CONTENT';
const WEB_OMITTED = '(网页内容已省略)';
/** 超预算时先删的成功只读工具调用行 */
const DROPPABLE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'git_readonly']);
/** pi 实际加载的仓库根上下文文件，取第一个存在的 */
const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

const chars = (text: string) => Array.from(text);
export const clipHead = (text: string, max: number): string => {
  const all = chars(text);
  return all.length <= max ? text : `${all.slice(0, max - 1).join('')}…`;
};
const clipTail = (text: string, max: number): string => {
  const all = chars(text);
  return all.length <= max ? text : `…${all.slice(all.length - max + 1).join('')}`;
};
/** 超出时取开头 head 字 + 结尾（max - head）字 */
export const clipHeadTail = (text: string, max: number, head: number): string => {
  const all = chars(text);
  if (all.length <= max) return text;
  return `${all.slice(0, head).join('')}\n…\n${all.slice(all.length - (max - head)).join('')}`;
};
const length = (text: string) => chars(text).length;

/** 含网页内容的文本段整段替换 */
const stripWeb = (text: string) => (text.includes(WEB_MARKER) ? WEB_OMITTED : text);

const argsPreview = (args: unknown): string => {
  let text: string;
  try {
    text = typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
  } catch {
    text = '';
  }
  return clipHead(text.replace(/\s+/g, ' ').trim(), TOOL_ARGS_MAX);
};

interface ExcerptLine {
  text: string;
  /** 超预算时可以先删 */
  droppable: boolean;
}

/** 一条消息摘录成若干行：正文、附件文件名、工具调用行与放行的工具输出 */
function messageLines(message: ChatMessage): ExcerptLine[] {
  const lines: ExcerptLine[] = [];
  const push = (text: string, droppable = false) => {
    if (text.trim() !== '') lines.push({ text: stripWeb(text), droppable });
  };
  if (message.role === 'user') {
    const { text, files } = splitChatFiles(message.text);
    for (const file of files) push(`User attached file: ${file.name}`);
    if (text.trim() !== '') push(`User: ${stripWeb(text)}`);
  } else {
    // 思考内容（message.thinking）不放
    if (message.text.trim() !== '') push(`Assistant: ${stripWeb(message.text)}`);
  }
  for (const call of message.toolCalls ?? []) {
    const succeeded = call.status === 'done';
    push(
      `[tool] ${call.name} ${argsPreview(call.args)}`,
      succeeded && DROPPABLE_TOOLS.has(call.name)
    );
    // web_fetch 的输出与报错正文一律不放
    if (call.name === 'web_fetch' || !call.output) continue;
    if (call.name.startsWith('mcp__')) {
      push(`[tool output] ${clipHead(stripWeb(call.output), MCP_OUTPUT_MAX)}`);
    } else if (call.status === 'error') {
      push(`[tool error] ${clipHead(stripWeb(call.output), TOOL_ERROR_MAX)}`);
    }
  }
  return lines;
}

/**
 * worker 会话摘录：只取 `since` 之后（含）的消息。超预算时先删成功的只读工具调用行，
 * 还超就从开头截掉、保留结尾。
 */
export function excerptMessages(
  messages: readonly ChatMessage[],
  since: number,
  budget: number
): string {
  let lines = messages
    .filter((message) => message.createdAt >= since && !message.streaming)
    .flatMap(messageLines);
  const join = () => lines.map((line) => line.text).join('\n');
  if (length(join()) > budget) lines = lines.filter((line) => !line.droppable);
  return clipTail(join(), budget);
}

/** 读取仓库根上下文文件（第一个存在的），截到预算；都没有时 undefined */
export async function readContextFile(workspacePath: string): Promise<string | undefined> {
  for (const name of CONTEXT_FILES) {
    try {
      return await readFile(join(workspacePath, name), 'utf8');
    } catch {
      // 不存在或读不了：试下一个
    }
  }
  return undefined;
}

/** 要摘录的尝试：普通任务取最后一次成功的；工作流任务取每个节点最后一次通过的 */
export function excerptAttempts(task: AcceptedTask): AcceptedDispatch[] {
  const succeeded = task.dispatches.filter((entry) => entry.status === 'succeeded');
  if (!task.task.workflow) return succeeded.slice(-1);
  const byNode = new Map<string, AcceptedDispatch>();
  for (const entry of succeeded) byNode.set(entry.nodeId ?? '', entry);
  return [...byNode.values()];
}

export interface MaterialParts {
  task: AcceptedTask;
  /** git diff --stat 输出（没有 diff 时 undefined） */
  diffStat?: string;
  /** 每个摘录尝试一段（已按预算截好） */
  excerpts: { attempt: AcceptedDispatch; text: string }[];
  flagged: readonly MemoryRow[];
  candidates: readonly MemoryRow[];
  contextFile?: string;
}

const VIA_TEXT: Record<AcceptedTask['acceptedVia'], string> = {
  merge: 'merged into the base branch',
  'pull-request': 'delivered as a pull request',
  'in-place': 'accepted in place (no git diff)',
  'no-change': 'merged with no code changes',
};

const memoryLine = (row: MemoryRow) => {
  let files: string[] = [];
  try {
    files = JSON.parse(row.files) as string[];
  } catch {
    // 坏的 files 当空
  }
  const suffix = Array.isArray(files) && files.length > 0 ? ` (files: ${files.join(', ')})` : '';
  return `- #${row.id} [${row.category}] ${row.content.replace(/\s+/g, ' ')}${suffix}`;
};

/** 拼材料正文（还没去密钥） */
export function buildMaterial(parts: MaterialParts): string {
  const { task } = parts;
  const sections: string[] = [];
  const section = (title: string, body: string | undefined) => {
    if (body !== undefined && body.trim() !== '') sections.push(`## ${title}\n${body.trim()}`);
  };
  section(
    'Task',
    clipHeadTail(`Title: ${task.task.title}\n\n${task.task.spec}`, BUDGET.task, BUDGET.taskHead)
  );
  const last = task.dispatches.filter((entry) => entry.status === 'succeeded').at(-1);
  const files = [...new Set(parts.excerpts.flatMap(({ attempt }) => attempt.filesModified ?? []))];
  const changed = files.slice(0, BUDGET.files).map((file) => `- ${file}`);
  if (files.length > BUDGET.files) changed.push(`- … ${files.length - BUDGET.files} more`);
  section(
    'Acceptance',
    [
      `The task was ${VIA_TEXT[task.acceptedVia]}.`,
      changed.length > 0 ? `Changed files:\n${changed.join('\n')}` : '',
      parts.diffStat ? `git diff --stat:\n${clipHead(parts.diffStat, BUDGET.diffStat)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  section('Final worker report', last?.summary && clipHead(last.summary, BUDGET.report));
  section(
    'Reasons earlier attempts were rejected (rejected approaches are not conclusions)',
    clipHead(task.reviewFeedback.map((entry) => `- ${entry.body}`).join('\n'), BUDGET.feedback)
  );
  section(
    'Worker session excerpt',
    parts.excerpts
      .map(({ attempt, text }) =>
        attempt.nodeId === undefined
          ? text
          : `### Workflow step ${attempt.nodeName ?? attempt.nodeId}\n${text}`
      )
      .join('\n\n')
  );
  section(
    'Memories a worker reported as possibly outdated during this task',
    parts.flagged
      .map((row) => `${memoryLine(row)}${row.flag_note ? ` — note: ${row.flag_note}` : ''}`)
      .join('\n')
  );
  section(
    'Repository context file (rules already recorded there)',
    parts.contextFile && clipHead(parts.contextFile, BUDGET.contextFile)
  );
  section('Existing memories (candidates)', parts.candidates.map(memoryLine).join('\n'));
  return sections.join('\n\n');
}

/** 检索候选用的查询词：标题、任务书开头、改动文件名 */
export function candidateQuery(task: AcceptedTask): string {
  const files = task.dispatches.flatMap((entry) => entry.filesModified ?? []);
  return [task.task.title, clipHead(task.task.spec, 500), ...files.slice(0, BUDGET.files)].join(
    ' '
  );
}
