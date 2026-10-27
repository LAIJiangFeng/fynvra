import type { ChatImage } from '@shared/types/chat';

/** 历史条目的上限：只留最近这么多条 */
export const INPUT_HISTORY_LIMIT = 200;

export interface InputHistoryEntry {
  text: string;
  images: ChatImage[];
}

/**
 * 输入框的历史浏览（终端式 ↑ / ↓），纯数据：
 * - `entries`：从旧到新，相邻重复已合并，最多 {@link INPUT_HISTORY_LIMIT} 条；
 * - `draft`：开始浏览前输入框里的文字与图片，翻到底部时回到它；
 * - `cursor`：正在看的条目下标；等于 `entries.length` 表示在底部（显示草稿、没在浏览）。
 */
export interface InputHistory {
  entries: readonly InputHistoryEntry[];
  draft: InputHistoryEntry;
  cursor: number;
}

/** 发送过的消息 → 历史条目：去掉空的，文字与图片都相同的相邻条目合并，只留最近的 200 条 */
export function historyEntries(sent: readonly InputHistoryEntry[]): InputHistoryEntry[] {
  const entries: InputHistoryEntry[] = [];
  for (const entry of sent) {
    if (!entry.text.trim() && entry.images.length === 0) continue;
    const previous = entries.at(-1);
    if (
      previous?.text === entry.text &&
      previous.images.length === entry.images.length &&
      previous.images.every(
        (image, index) =>
          image.mimeType === entry.images[index]?.mimeType &&
          image.data === entry.images[index]?.data
      )
    ) {
      continue;
    }
    entries.push(entry);
  }
  return entries.slice(-INPUT_HISTORY_LIMIT);
}

/** 以输入框当前的文字与图片为草稿开始一次浏览：还停在底部 */
export function startHistory(
  sent: readonly InputHistoryEntry[],
  draft: InputHistoryEntry
): InputHistory {
  const entries = historyEntries(sent);
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

/** 输入框里该显示的文字与图片：正在看的条目，或底部的草稿 */
export function currentEntry(state: InputHistory): InputHistoryEntry {
  return state.entries[cursorOf(state)] ?? state.draft;
}

export function currentText(state: InputHistory): string {
  return currentEntry(state).text;
}
