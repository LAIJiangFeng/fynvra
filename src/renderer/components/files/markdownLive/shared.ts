import type { syntaxTree } from '@codemirror/language';
import type { WorkspaceFileEntry } from '@shared/types/files';
import type { EditorState } from '@uiw/react-codemirror';
import type { MarkdownReferences } from '@/lib/markdownPreview';
import type { FilesStore } from '@/stores/files';

export type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export interface LiveContext {
  file: WorkspaceFileEntry;
  store: FilesStore;
  references: MarkdownReferences;
  /** 链接上的悬停提示（Ctrl/Cmd+点击打开）。 */
  linkHint: string;
}

/** 节点最后一个字符所在行；块节点的 to 可能落在下一行行首。 */
export function lastLine(state: EditorState, from: number, to: number) {
  return state.doc.lineAt(Math.max(from, to - 1));
}

/** 「激活」：任一选区触及该元素所在的行，此时显示源码。 */
export function touches(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from;
  const end = lastLine(state, from, to).to;
  return state.selection.ranges.some((range) => range.from <= end && range.to >= start);
}
