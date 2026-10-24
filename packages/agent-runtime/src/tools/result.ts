import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

export type ToolResult = AgentToolResult<unknown>;

export function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

/** 失败结果：模型看到的是错误结果（`isError`），但 execute 本身不抛异常 */
export function errorResult(toolName: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `## Error\n${toolName} failed: ${message}` }],
    details: undefined,
    isError: true,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 包住 execute 主体：任何异常（包括 Host 违约抛出的）都转成错误文本 */
export async function safely(
  toolName: string,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return errorResult(toolName, errorMessage(error));
  }
}

export interface Truncated {
  text: string;
  truncated: boolean;
  /** 被省略的字符数 */
  omitted: number;
}

/** 保留开头 maxChars 个字符（不切开代理对） */
export function truncateHeadChars(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
  let end = maxChars;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(0, end), truncated: true, omitted: text.length - end };
}

/** 保留结尾 maxChars 个字符（报错通常在输出末尾） */
export function truncateTailChars(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
  let start = text.length - maxChars;
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return { text: text.slice(start), truncated: true, omitted: start };
}

/** 代码块：围栏比内容里最长的反引号串更长，内容里的 ``` 不会提前闭合 */
export function fence(text: string, lang = ''): string {
  const marker = '`'.repeat(longestBacktickRun(text, 2) + 1);
  return `${marker}${lang}\n${text}\n${marker}`;
}

/** 行内代码，同样按内容选择反引号个数 */
export function inlineCode(text: string): string {
  const marker = '`'.repeat(longestBacktickRun(text, 0) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${text}${pad}${marker}`;
}

function longestBacktickRun(text: string, floor: number): number {
  let longest = floor;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
