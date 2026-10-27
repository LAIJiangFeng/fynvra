type LineEdge = 'first' | 'last';
type LineTops = { caret: number; edge: number };
type CaretSelection = { value: string; selectionStart: number; selectionEnd: number };
type MeasureLines = (caret: number, edge: number) => LineTops | null;

/** A selection belongs to the browser. Logical newlines can rule out an edge without layout. */
export function caretOnLineEdge(
  input: CaretSelection,
  edge: LineEdge,
  measure?: MeasureLines
): boolean {
  const { selectionStart: caret, selectionEnd, value } = input;
  if (caret !== selectionEnd) return false;
  const outside = edge === 'first' ? value.slice(0, caret) : value.slice(caret);
  if (outside.includes('\n')) return false;
  const boundary = edge === 'first' ? 0 : value.length;
  if (caret === boundary) return true;
  const tops = measure?.(caret, boundary);
  // No layout (e.g. node tests or a detached textarea): retain logical-line behavior.
  return tops == null || Math.abs(tops.caret - tops.edge) <= 1;
}
