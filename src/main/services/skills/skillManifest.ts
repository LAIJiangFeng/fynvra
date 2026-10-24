import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errorMessage } from '@shared/guards';

export interface SkillManifest {
  name: string;
  description?: string;
}

/** Agent Skills 规范里 description 的上限；超出部分截掉，skills.json 保持小巧。 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 读 `<dir>/SKILL.md` 的 frontmatter：name 缺省用目录名。没有 SKILL.md 时返回错误。 */
export async function readSkillManifest(
  dir: string
): Promise<{ ok: true; manifest: SkillManifest } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `目录里没有 SKILL.md：${dir}`
          : `读取 SKILL.md 失败：${errorMessage(error)}`,
    };
  }
  const { name, description } = parseSkillFrontmatter(text);
  return {
    ok: true,
    manifest: {
      name: name ?? basename(dir),
      ...(description ? { description: description.slice(0, MAX_DESCRIPTION_LENGTH) } : {}),
    },
  };
}

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const BLOCK_HEADER = /^([|>])[+-]?\d*\s*(?:#.*)?$/;

/**
 * 从 SKILL.md 的 YAML frontmatter 取 name / description。只认顶层标量，覆盖技能文件里常见的写法：
 * 普通标量（可跨行、可带行尾注释）、单 / 双引号、`|` 字面块与 `>` 折叠块；嵌套映射（如 metadata）跳过。
 * 不引入 YAML 依赖：根 package.json 不在本卡范围内。
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return {};
  const fields = readTopLevelScalars(lines.slice(1, end));
  const name = fields.get('name')?.trim();
  const description = fields.get('description')?.trim();
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/** 顶层 `key: value` 及其后缩进（或空白）的续行。 */
function readTopLevelScalars(lines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const match = KEY_LINE.exec(lines[index] ?? '');
    index += 1;
    if (!match) continue;
    const continuation: string[] = [];
    while (index < lines.length && /^(?:\s|$)/.test(lines[index] ?? '')) {
      continuation.push(lines[index] ?? '');
      index += 1;
    }
    fields.set(match[1] ?? '', readScalar((match[2] ?? '').trim(), continuation));
  }
  return fields;
}

function readScalar(value: string, continuation: string[]): string {
  const header = BLOCK_HEADER.exec(value);
  if (header) {
    const body = dedent(continuation);
    return header[1] === '|' ? body.join('\n') : fold(body);
  }
  const rest = continuation.map((line) => line.trim()).filter((line) => line !== '');
  if (value.startsWith('"')) return readDoubleQuoted([value, ...rest].join(' '));
  if (value.startsWith("'")) return readSingleQuoted([value, ...rest].join(' '));
  return [value, ...rest]
    .map(stripComment)
    .filter((part) => part !== '')
    .join(' ');
}

function stripComment(line: string): string {
  return line.replace(/(?:^|\s+)#.*$/, '').trim();
}

/** 块内容去掉公共缩进与末尾空行。 */
function dedent(lines: string[]): string[] {
  const body = [...lines];
  while (body.length > 0 && body.at(-1)?.trim() === '') body.pop();
  const indents = body
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return body.map((line) => (line.trim() === '' ? '' : line.slice(indent)));
}

/** YAML 折叠：相邻非空行以空格连接，每个空行变成一个换行。 */
function fold(lines: string[]): string {
  let folded = '';
  let breaks = 0;
  for (const line of lines) {
    if (line === '') {
      breaks += 1;
      continue;
    }
    if (folded) folded += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    folded += line;
    breaks = 0;
  }
  return folded;
}

function readDoubleQuoted(text: string): string {
  const quoted = text.replace(/"\s+#.*$/, '"');
  try {
    const value: unknown = JSON.parse(quoted);
    if (typeof value === 'string') return value;
  } catch {
    // YAML 独有的转义（如 \x41）JSON 不认，退回只处理 \" 与 \\
  }
  const close = quoted.lastIndexOf('"');
  return (close > 0 ? quoted.slice(1, close) : quoted.slice(1))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readSingleQuoted(text: string): string {
  const close = text.lastIndexOf("'");
  return (close > 0 ? text.slice(1, close) : text.slice(1)).replace(/''/g, "'");
}
