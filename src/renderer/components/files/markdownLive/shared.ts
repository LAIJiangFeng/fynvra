import type { syntaxTree } from '@codemirror/language';
import type { WorkspaceFileEntry } from '@shared/types/files';
import {
  type EditorState,
  type EditorView,
  type Extension,
  StateEffect,
  StateField,
  ViewPlugin,
} from '@uiw/react-codemirror';
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

const setFocused = StateEffect.define<boolean>();

/** 编辑器（含 Ctrl+F 面板）是否持有焦点；块级 StateField 和行内 ViewPlugin 都从这里读取。 */
const focusState = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocused)) value = effect.value;
    return value;
  },
});

/**
 * 焦点以 view.dom 内的 activeElement 为准：内容区和搜索面板都算聚焦，这样 Ctrl+F 跳到的匹配
 * 仍会展开源码；切到其他窗口时 activeElement 不变，不会整页闪回渲染态。
 * 同步放到微任务里，避免在 CodeMirror 更新过程中（例如更新内调用 focus()）再次 dispatch。
 */
const focusSync = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    private readonly schedule = () =>
      queueMicrotask(() => {
        if (this.destroyed) return;
        const { view } = this;
        const focused = view.dom.contains(view.root.activeElement);
        if (view.state.field(focusState, false) !== focused)
          view.dispatch({ effects: setFocused.of(focused) });
      });
    constructor(readonly view: EditorView) {
      view.dom.addEventListener('focusin', this.schedule);
      view.dom.addEventListener('focusout', this.schedule);
      // 切换到实时预览时编辑器可能已经聚焦。
      this.schedule();
    }
    destroy() {
      this.destroyed = true;
      this.view.dom.removeEventListener('focusin', this.schedule);
      this.view.dom.removeEventListener('focusout', this.schedule);
    }
  }
);

export const focusTracking: Extension = [focusState, focusSync];

export function isFocused(state: EditorState): boolean {
  return state.field(focusState, false) ?? false;
}

export function focusChanged(before: EditorState, after: EditorState): boolean {
  return isFocused(before) !== isFocused(after);
}

/** 「激活」：编辑器聚焦且任一选区触及该元素所在的行，此时显示源码；未聚焦时一律按渲染效果显示。 */
export function touches(state: EditorState, from: number, to: number): boolean {
  if (!isFocused(state)) return false;
  const start = state.doc.lineAt(from).from;
  const end = lastLine(state, from, to).to;
  return state.selection.ranges.some((range) => range.from <= end && range.to >= start);
}
