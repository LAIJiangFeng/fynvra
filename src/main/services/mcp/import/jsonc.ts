// VS Code 的 mcp.json、OpenCode 的配置是 JSONC（可带注释与尾逗号）。其它来源是 JSON，用同一个解析也一样。

export type JsoncResult = { ok: true; value: unknown } | { ok: false; line?: number };

/**
 * 去掉字符串外的 `//`、`/* *\/` 注释与尾逗号，再按 JSON 解析。注释与尾逗号换成空格、换行保留，
 * 所以出错时的行号与原文一致。错误只给行号：V8 的错误信息会引用文件片段，而这些文件里可能有凭证。
 * 空白文本视为没有内容（value 为 undefined）。
 */
export function parseJsonc(source: string): JsoncResult {
  if (source.trim() === '') return { ok: true, value: undefined };
  const stripped = stripTrailingCommas(stripComments(source));
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (error) {
    const line = errorLine(error, stripped);
    return line === undefined ? { ok: false } : { ok: false, line };
  }
}

/** 注释换成等长的空格（保留换行）；字符串原样跳过。 */
function stripComments(source: string): string {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      i = stringEnd(source, i);
      continue;
    }
    const next = source[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : next === '/' ? close : close + 2;
      out += source.slice(copied, i) + source.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = copied = stop;
      continue;
    }
    i += 1;
  }
  return out + source.slice(copied);
}

/** 后面（隔着空白）紧跟 `}` 或 `]` 的逗号换成空格。注释已经换成空格了。 */
function stripTrailingCommas(source: string): string {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      i = stringEnd(source, i);
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j] ?? '')) j += 1;
      if (source[j] === '}' || source[j] === ']') {
        out += `${source.slice(copied, i)} `;
        copied = i + 1;
      }
    }
    i += 1;
  }
  return out + source.slice(copied);
}

/** 从开引号起，返回闭引号之后的位置。JSON 字符串不能跨行：没闭合就停在换行处，交给 JSON.parse 报错。 */
function stringEnd(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '\n') return i;
    else i += 1;
  }
  return source.length;
}

/**
 * V8 的结构化错误以「at position N (line L column C)」结尾，只取这一段；
 * 「Unexpected token …, "<片段>" is not valid JSON」这类带原文的不解析。
 */
function errorLine(error: unknown, source: string): number | undefined {
  const message = error instanceof Error ? error.message : '';
  const match = / at position (\d+)(?: \(line (\d+) column \d+\))?$/.exec(message);
  if (!match) return undefined;
  if (match[2]) return Number(match[2]);
  return source.slice(0, Number(match[1])).split('\n').length;
}
