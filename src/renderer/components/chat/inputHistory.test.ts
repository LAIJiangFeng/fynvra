import { describe, expect, it } from 'vitest';
import {
  currentText,
  down,
  historyEntries,
  INPUT_HISTORY_LIMIT,
  type InputHistory,
  isBrowsing,
  startHistory,
  toDraft,
  up,
} from './inputHistory';

describe('historyEntries', () => {
  it('keeps the order (oldest first) and merges adjacent repeats only', () => {
    expect(historyEntries(['a', 'a', 'b', 'b', 'b', 'a', 'c', 'c'])).toEqual(['a', 'b', 'a', 'c']);
  });

  it(`keeps only the newest ${INPUT_HISTORY_LIMIT} entries`, () => {
    const texts = Array.from({ length: 250 }, (_, index) => `prompt ${index}`);
    const entries = historyEntries(texts);
    expect(entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(entries[0]).toBe('prompt 50');
    expect(entries.at(-1)).toBe('prompt 249');
  });

  it('counts the limit after merging repeats', () => {
    const texts = Array.from({ length: 220 }, (_, index) => `p${index}`).flatMap((text) => [
      text,
      text,
    ]);
    const entries = historyEntries(texts);
    expect(entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(entries[0]).toBe('p20');
  });

  it('leaves out empty entries', () => {
    expect(historyEntries(['', 'a', '   ', 'b'])).toEqual(['a', 'b']);
  });
});

describe('browsing with up / down', () => {
  const start = (draft = 'half-written') => startHistory(['first', 'second', 'third'], draft);

  it('starts at the bottom, showing the draft, not browsing yet', () => {
    const state = start();
    expect(state).toEqual({
      entries: ['first', 'second', 'third'],
      draft: 'half-written',
      cursor: 3,
    });
    expect(isBrowsing(state)).toBe(false);
    expect(currentText(state)).toBe('half-written');
  });

  it('goes to older entries with up and stays at the oldest', () => {
    let state = start();
    state = up(state);
    expect(currentText(state)).toBe('third');
    expect(isBrowsing(state)).toBe(true);
    state = up(up(state));
    expect(currentText(state)).toBe('first');
    expect(up(state)).toBe(state);
  });

  it('goes back to newer entries with down and returns to the draft at the bottom', () => {
    let state = up(up(start()));
    expect(currentText(state)).toBe('second');
    state = down(state);
    expect(currentText(state)).toBe('third');
    state = down(state);
    expect(currentText(state)).toBe('half-written');
    expect(isBrowsing(state)).toBe(false);
    // 已经在底部：down 不再动
    expect(down(state)).toBe(state);
  });

  it('keeps the draft while browsing, also an empty one', () => {
    const state = up(up(up(start(''))));
    expect(state.draft).toBe('');
    expect(currentText(toDraft(state))).toBe('');
  });

  it('goes straight back to the draft (Esc)', () => {
    const state = toDraft(up(up(start())));
    expect(isBrowsing(state)).toBe(false);
    expect(currentText(state)).toBe('half-written');
    expect(toDraft(state)).toBe(state);
  });

  it('has nothing to show without history', () => {
    const empty = startHistory([], 'draft');
    expect(up(empty)).toBe(empty);
    expect(down(empty)).toBe(empty);
    expect(currentText(empty)).toBe('draft');
    expect(isBrowsing(empty)).toBe(false);
  });

  it('browses the merged entries: repeats are one step', () => {
    let state: InputHistory = startHistory(['run tests', 'run tests', 'fix lint', 'fix lint'], '');
    state = up(state);
    expect(currentText(state)).toBe('fix lint');
    state = up(state);
    expect(currentText(state)).toBe('run tests');
    expect(up(state)).toBe(state);
  });

  it('works on a state built by hand, as long as the cursor is in range', () => {
    const state: InputHistory = { entries: ['a', 'b'], draft: 'd', cursor: 1 };
    expect(currentText(state)).toBe('b');
    expect(currentText(up(state))).toBe('a');
    expect(currentText(down(state))).toBe('d');
    // 越界的游标按底部（草稿）处理
    expect(currentText({ ...state, cursor: 9 })).toBe('d');
    expect(currentText(up({ ...state, cursor: 9 }))).toBe('b');
  });
});
