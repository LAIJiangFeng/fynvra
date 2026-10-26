import { describe, expect, it, vi } from 'vitest';
import { caretOnLineEdge } from './caretLine';

// The logical-line fallback deliberately works without a DOM/layout engine.
function textarea(value: string, start: number, end = start) {
  return { value, selectionStart: start, selectionEnd: end };
}

describe('caretOnLineEdge without layout', () => {
  it.each([
    { value: '', position: 0, first: true, last: true },
    { value: 'one line', position: 3, first: true, last: true },
    { value: 'one\ntwo\nthree', position: 0, first: true, last: false },
    { value: 'one\ntwo\nthree', position: 3, first: true, last: false },
    { value: 'one\ntwo\nthree', position: 4, first: false, last: false },
    { value: 'one\ntwo\nthree', position: 7, first: false, last: false },
    { value: 'one\ntwo\nthree', position: 8, first: false, last: true },
    { value: 'one\ntwo\nthree', position: 13, first: false, last: true },
    { value: '\n', position: 0, first: true, last: false },
    { value: '\n', position: 1, first: false, last: true },
    { value: '\n\n', position: 1, first: false, last: false },
    { value: 'one\n', position: 4, first: false, last: true },
  ])('checks position $position in "$value"', ({ value, position, first, last }) => {
    const input = textarea(value, position);
    expect(caretOnLineEdge(input, 'first')).toBe(first);
    expect(caretOnLineEdge(input, 'last')).toBe(last);
  });

  it.each(['first', 'last'] as const)('leaves selections to the browser at the %s edge', (edge) => {
    const measure = vi.fn();
    expect(caretOnLineEdge(textarea('selected', 0, 8), edge, measure)).toBe(false);
    expect(measure).not.toHaveBeenCalled();
  });

  it('does not measure when a logical newline already rules out the edge', () => {
    const measure = vi.fn();
    expect(caretOnLineEdge(textarea('first\nmiddle\nlast', 8), 'first', measure)).toBe(false);
    expect(caretOnLineEdge(textarea('first\nmiddle\nlast', 8), 'last', measure)).toBe(false);
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('caretOnLineEdge with visual line positions', () => {
  const input = textarea('a long line that wraps onto several visual rows', 20);

  it('lets Up move within a soft-wrapped logical line', () => {
    const measure = vi.fn(() => ({ caret: 32, edge: 12 }));
    expect(caretOnLineEdge(input, 'first', measure)).toBe(false);
    expect(measure).toHaveBeenCalledWith(20, 0);
  });

  it('lets Down move within a soft-wrapped logical line', () => {
    const measure = vi.fn(() => ({ caret: 32, edge: 52 }));
    expect(caretOnLineEdge(input, 'last', measure)).toBe(false);
    expect(measure).toHaveBeenCalledWith(20, input.value.length);
  });

  it.each(['first', 'last'] as const)('allows history only on the visual %s row', (edge) => {
    expect(caretOnLineEdge(input, edge, () => ({ caret: 32, edge: 32 }))).toBe(true);
    expect(caretOnLineEdge(input, edge, () => ({ caret: 32.5, edge: 32 }))).toBe(true);
  });

  it('recognizes the start/end placement used when switching history entries', () => {
    const value = 'a long wrapped history entry';
    const measure = vi.fn();
    expect(caretOnLineEdge(textarea(value, 0), 'first', measure)).toBe(true);
    expect(caretOnLineEdge(textarea(value, value.length), 'last', measure)).toBe(true);
    expect(measure).not.toHaveBeenCalled();
    // Moving back through that entry must still traverse its visual rows.
    expect(caretOnLineEdge(textarea(value, 10), 'first', () => ({ caret: 32, edge: 12 }))).toBe(
      false
    );
    expect(caretOnLineEdge(textarea(value, 10), 'last', () => ({ caret: 32, edge: 52 }))).toBe(
      false
    );
  });
});
