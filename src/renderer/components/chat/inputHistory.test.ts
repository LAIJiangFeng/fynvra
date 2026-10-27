import type { ChatImage } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import {
  currentEntry,
  currentText,
  down,
  historyEntries,
  INPUT_HISTORY_LIMIT,
  type InputHistory,
  type InputHistoryEntry,
  isBrowsing,
  startHistory,
  toDraft,
  up,
} from './inputHistory';

const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const PHOTO: ChatImage = { data: '/9j/4AAQ', mimeType: 'image/jpeg' };
const entry = (text: string, images: ChatImage[] = []): InputHistoryEntry => ({ text, images });
const textEntries = (texts: string[]) => texts.map((text) => entry(text));

describe('historyEntries', () => {
  it('keeps the order (oldest first) and merges adjacent repeats only', () => {
    expect(historyEntries(textEntries(['a', 'a', 'b', 'b', 'b', 'a', 'c', 'c']))).toEqual(
      textEntries(['a', 'b', 'a', 'c'])
    );
  });

  it(`keeps only the newest ${INPUT_HISTORY_LIMIT} entries`, () => {
    const texts = Array.from({ length: 250 }, (_, index) => `prompt ${index}`);
    const entries = historyEntries(textEntries(texts));
    expect(entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(entries[0]).toEqual(entry('prompt 50'));
    expect(entries.at(-1)).toEqual(entry('prompt 249'));
  });

  it('counts the limit after merging repeats', () => {
    const texts = Array.from({ length: 220 }, (_, index) => `p${index}`).flatMap((text) => [
      text,
      text,
    ]);
    const entries = historyEntries(textEntries(texts));
    expect(entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(entries[0]).toEqual(entry('p20'));
  });

  it('leaves out empty entries', () => {
    expect(historyEntries(textEntries(['', 'a', '   ', 'b']))).toEqual(textEntries(['a', 'b']));
  });

  it('keeps image-only entries', () => {
    const imageOnly = entry('', [SHOT]);
    const whitespaceWithImage = entry('   ', [PHOTO]);
    expect(historyEntries([entry(''), imageOnly, entry('   '), whitespaceWithImage])).toEqual([
      imageOnly,
      whitespaceWithImage,
    ]);
  });

  it('merges adjacent entries only when text and ordered image contents match', () => {
    const first = entry('look', [SHOT, PHOTO]);
    const repeated = entry('look', [{ ...SHOT }, { ...PHOTO }]);
    const reversed = entry('look', [PHOTO, SHOT]);
    const fewer = entry('look', [PHOTO]);
    const differentData = entry('look', [{ ...PHOTO, data: SHOT.data }]);
    const differentType = entry('look', [SHOT]);
    const noImages = entry('look');
    const differentText = entry('again', [SHOT]);
    expect(
      historyEntries([
        first,
        repeated,
        reversed,
        fewer,
        differentData,
        differentType,
        noImages,
        differentText,
        first,
      ])
    ).toEqual([
      first,
      reversed,
      fewer,
      differentData,
      differentType,
      noImages,
      differentText,
      first,
    ]);
  });
});

describe('browsing with up / down', () => {
  const start = (draft = 'half-written') =>
    startHistory(textEntries(['first', 'second', 'third']), entry(draft));

  it('starts at the bottom, showing the draft, not browsing yet', () => {
    const state = start();
    expect(state).toEqual({
      entries: textEntries(['first', 'second', 'third']),
      draft: entry('half-written'),
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
    expect(state.draft).toEqual(entry(''));
    expect(currentText(toDraft(state))).toBe('');
  });

  it('goes straight back to the draft (Esc)', () => {
    const state = toDraft(up(up(start())));
    expect(isBrowsing(state)).toBe(false);
    expect(currentText(state)).toBe('half-written');
    expect(toDraft(state)).toBe(state);
  });

  it('restores the sent images and then the draft images with down or Esc', () => {
    const sent = entry('sent', [SHOT, PHOTO]);
    const draft = entry('half-written', [PHOTO]);
    const initial = startHistory([sent], draft);
    const browsing = up(initial);

    expect(currentEntry(browsing)).toEqual(sent);
    expect(currentEntry(down(browsing))).toEqual(draft);
    expect(currentEntry(toDraft(browsing))).toEqual(draft);
    expect(currentEntry(initial)).toEqual(draft);
    expect(browsing.draft).toEqual(draft);
    expect(currentEntry(browsing)).toEqual(sent);
  });

  it('changes images between entries even with the same text', () => {
    const older = entry('look', [SHOT]);
    const newer = entry('look', [SHOT, PHOTO]);
    const draft = entry('look', [PHOTO]);
    let state = startHistory([older, newer], draft);
    state = up(state);
    expect(currentEntry(state)).toEqual(newer);
    state = up(state);
    expect(currentEntry(state)).toEqual(older);
    state = down(state);
    expect(currentEntry(state)).toEqual(newer);
    expect(currentEntry(down(state))).toEqual(draft);
  });

  it('browses image-only and text-only entries and restores an empty draft', () => {
    const imageOnly = entry('', [SHOT]);
    const textOnly = entry('text only');
    const initial = startHistory([textOnly, imageOnly], entry(''));
    const latest = up(initial);
    expect(currentEntry(latest)).toEqual(imageOnly);
    expect(currentEntry(up(latest))).toEqual(textOnly);
    expect(currentEntry(down(latest))).toEqual(entry(''));
    expect(currentEntry(toDraft(latest))).toEqual(entry(''));
  });

  it('has nothing to show without history', () => {
    const empty = startHistory([], entry('draft'));
    expect(up(empty)).toBe(empty);
    expect(down(empty)).toBe(empty);
    expect(currentText(empty)).toBe('draft');
    expect(isBrowsing(empty)).toBe(false);
  });

  it('browses the merged entries: repeats are one step', () => {
    let state: InputHistory = startHistory(
      textEntries(['run tests', 'run tests', 'fix lint', 'fix lint']),
      entry('')
    );
    state = up(state);
    expect(currentText(state)).toBe('fix lint');
    state = up(state);
    expect(currentText(state)).toBe('run tests');
    expect(up(state)).toBe(state);
  });

  it('works on a state built by hand, as long as the cursor is in range', () => {
    const state: InputHistory = { entries: textEntries(['a', 'b']), draft: entry('d'), cursor: 1 };
    expect(currentText(state)).toBe('b');
    expect(currentText(up(state))).toBe('a');
    expect(currentText(down(state))).toBe('d');
    // 越界的游标按底部（草稿）处理
    expect(currentText({ ...state, cursor: 9 })).toBe('d');
    expect(currentText(up({ ...state, cursor: 9 }))).toBe('b');
  });
});
