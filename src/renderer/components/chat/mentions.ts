// 编排会话输入框里的 `/工作流`、`@角色` 写法（纯函数；不碰 store / DOM）

export type MentionSymbol = '/' | '@';
export type MentionKind = 'workflow' | 'role';

/** 可被引用的工作流或角色 */
export interface MentionTarget {
  kind: MentionKind;
  id: string;
  name: string;
}

/** 正在输入的引用：`start` 是符号所在位置，`query` 是符号到光标之间的筛选词 */
export interface MentionTrigger {
  symbol: MentionSymbol;
  start: number;
  query: string;
}

export const mentionKind = (symbol: MentionSymbol): MentionKind =>
  symbol === '/' ? 'workflow' : 'role';

/**
 * 光标前是否正在输入引用：符号在开头或紧跟空白之后，筛选词里没有空白和 `/`。
 * 所以 `/api/login`、`a@b.com` 不触发。有选区时不触发。
 */
export function findMentionTrigger(
  text: string,
  selectionStart: number,
  selectionEnd: number
): MentionTrigger | null {
  if (selectionStart !== selectionEnd) return null;
  let index = selectionStart - 1;
  while (index >= 0) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) return null;
    if (char === '/' || char === '@') {
      const before = index === 0 ? '' : (text[index - 1] ?? '');
      if (before !== '' && !/\s/.test(before)) return null;
      const query = text.slice(index + 1, selectionStart);
      if (query.includes('/') || query.includes('@')) return null;
      return { symbol: char, start: index, query };
    }
    index -= 1;
  }
  return null;
}

/** 名称或 id 不区分大小写包含筛选词 */
export function filterMentionTargets<T extends { id: string; name: string }>(
  targets: readonly T[],
  query: string
): T[] {
  const needle = query.toLowerCase();
  if (!needle) return [...targets];
  return targets.filter(
    (target) =>
      target.name.toLowerCase().includes(needle) || target.id.toLowerCase().includes(needle)
  );
}

/** 插入的 token：名称含空白时用「」括起来 */
export function formatMention(symbol: MentionSymbol, name: string): string {
  return /\s/.test(name) ? `${symbol}「${name}」` : `${symbol}${name}`;
}

/** 选中后：把「符号 + 筛选词」换成 token 加一个空格，返回新文本与光标位置 */
export function applyMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  name: string
): { text: string; caret: number } {
  const token = `${formatMention(trigger.symbol, name)} `;
  return {
    text: text.slice(0, trigger.start) + token + text.slice(caret),
    caret: trigger.start + token.length,
  };
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; target: MentionTarget };

/** 名称后面紧跟这些字符时不算完整 token（避免 `@dev` 匹配到 `@developer`） */
const WORD_CHAR = /[A-Za-z0-9_\-.]/;

/** 在 `position`（符号之后）找已知目标：先认 `「名称」`，再按最长前缀匹配名称或 id */
function matchAt(
  text: string,
  position: number,
  candidates: readonly MentionTarget[]
): { length: number; target: MentionTarget } | null {
  if (text[position] === '「') {
    const close = text.indexOf('」', position + 1);
    if (close < 0) return null;
    const inner = text.slice(position + 1, close).toLowerCase();
    const target = candidates.find(
      (candidate) =>
        candidate.name.toLowerCase() === inner || candidate.id.toLowerCase() === inner
    );
    return target ? { length: close + 1 - position, target } : null;
  }
  let best: { length: number; target: MentionTarget } | null = null;
  for (const target of candidates) {
    for (const label of [target.name, target.id]) {
      if (!label || /\s/.test(label) || label.length <= (best?.length ?? 0)) continue;
      if (text.slice(position, position + label.length).toLowerCase() !== label.toLowerCase())
        continue;
      const next = text[position + label.length] ?? '';
      if (next && WORD_CHAR.test(next) && WORD_CHAR.test(label.at(-1) ?? '')) continue;
      best = { length: label.length, target };
    }
  }
  return best;
}

/** 把文本切成普通文字与已知引用；只认开头或空白之后的 `/`、`@`。拼回去与原文相同 */
export function splitMentions(text: string, targets: readonly MentionTarget[]): MentionSegment[] {
  const segments: MentionSegment[] = [];
  if (targets.length === 0 || !/[/@]/.test(text)) return [{ type: 'text', text }];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const before = index === 0 ? '' : (text[index - 1] ?? '');
    if ((char === '/' || char === '@') && (before === '' || /\s/.test(before))) {
      const kind = mentionKind(char);
      const match = matchAt(
        text,
        index + 1,
        targets.filter((target) => target.kind === kind)
      );
      if (match) {
        if (index > plainStart)
          segments.push({ type: 'text', text: text.slice(plainStart, index) });
        const end = index + 1 + match.length;
        segments.push({ type: 'mention', text: text.slice(index, end), target: match.target });
        index = end;
        plainStart = end;
        continue;
      }
    }
    index += 1;
  }
  if (plainStart < text.length) segments.push({ type: 'text', text: text.slice(plainStart) });
  return segments;
}
