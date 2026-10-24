/** 历史条目的上限：只留最近这么多条 */
export const INPUT_HISTORY_LIMIT = 200;

/**
 * 输入框的历史浏览（终端式 ↑ / ↓），纯数据：
 * - `entries`：从旧到新，相邻重复已合并，最多 {@link INPUT_HISTORY_LIMIT} 条；
 * - `draft`：开始浏览前输入框里的文字，翻到底部时回到它；
 * - `cursor`：正在看的条目下标；等于 `entries.length` 表示在底部（显示草稿、没在浏览）。
 */
export interface InputHistory {
  entries: readonly string[];
  draft: string;
  cursor: number;
}

/** 发送过的文字 → 历史条目：去掉空的，相邻重复的合并为一条，只留最近的 200 条 */
export function historyEntries(texts: readonly string[]): string[] {
  const entries: string[] = [];
  for (const text of texts) {
    if (!text.trim() || entries.at(-1) === text) continue;
    entries.push(text);
  }
  return entries.slice(-INPUT_HISTORY_LIMIT);
}

/** 以输入框当前的文字为草稿开始一次浏览：还停在底部 */
export function startHistory(texts: readonly string[], draft: string): InputHistory {
  const entries = historyEntries(texts);
  return { entries, draft, cursor: entries.length };
}

/** 越界的游标按底部处理 */
function cursorOf(state: InputHistory): number {
  return Math.min(Math.max(state.cursor, 0), state.entries.length);
}

/** 上一条（更旧）；已经是最旧的一条时原样返回 */
export function up(state: InputHistory): InputHistory {
  const cursor = cursorOf(state);
  return cursor > 0 ? { ...state, cursor: cursor - 1 } : state;
}

/** 下一条（更新）；越过最新的一条回到草稿，已在底部时原样返回 */
export function down(state: InputHistory): InputHistory {
  const cursor = cursorOf(state);
  return cursor < state.entries.length ? { ...state, cursor: cursor + 1 } : state;
}

/** 直接回到草稿（Esc） */
export function toDraft(state: InputHistory): InputHistory {
  return cursorOf(state) === state.entries.length
    ? state
    : { ...state, cursor: state.entries.length };
}

export function isBrowsing(state: InputHistory): boolean {
  return cursorOf(state) < state.entries.length;
}

/** 输入框里该显示的文字：正在看的条目，或底部的草稿 */
export function currentText(state: InputHistory): string {
  return state.entries[cursorOf(state)] ?? state.draft;
}
