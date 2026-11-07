import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  type DecorationSet,
  type EditorState,
  EditorView,
  type Range,
  StateField,
  WidgetType,
} from '@uiw/react-codemirror';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/i18n/I18nProvider';
import { FileMarkdownPreview } from '../FileMarkdownPreview';
import { type LiveContext, lastLine, touches } from './shared';

const mounted = new WeakMap<HTMLElement, { root: Root; observer: ResizeObserver }>();

/**
 * 表格 / HTML 块的渲染结果：在 widget 内挂一个 React root，复用只读预览的
 * Markdown + HTML_PLUGINS（同一套 sanitize）+ 图片/链接组件。eq 按源文本比较，按键不重建。
 */
class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly ctx: LiveContext
  ) {
    super();
  }
  eq(other: RenderedBlockWidget) {
    return other.source === this.source && other.ctx === this.ctx;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-ml-block';
    const container = document.createElement('div');
    dom.append(container);
    const root = createRoot(container);
    root.render(
      <I18nProvider>
        <FileMarkdownPreview
          file={this.ctx.file}
          store={this.ctx.store}
          text={this.source}
          className=""
        />
      </I18nProvider>
    );
    // 内容异步渲染、图片晚到都会改变高度，需要让编辑器重新测量。
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(dom);
    mounted.set(dom, { root, observer });
    // 普通点击把光标移进源码（显示源码）；Ctrl/Cmd+点击交给渲染出的链接。
    dom.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
        view.focus();
      },
      true
    );
    dom.addEventListener(
      'click',
      (event) => {
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
    return dom;
  }
  destroy(dom: HTMLElement) {
    const entry = mounted.get(dom);
    if (!entry) return;
    mounted.delete(dom);
    entry.observer.disconnect();
    // 编辑器更新可能发生在 React 提交阶段，延后卸载避免同步卸载警告。
    setTimeout(() => entry.root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

/** 只替换顶层的表格和 HTML 块；嵌在引用/列表中的保持源码。 */
function build(state: EditorState, ctx: LiveContext): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Document') return true;
      if (
        (node.name === 'Table' || node.name === 'HTMLBlock') &&
        !touches(state, node.from, node.to)
      ) {
        const from = state.doc.lineAt(node.from).from;
        const to = lastLine(state, node.from, node.to).to;
        ranges.push(
          Decoration.replace({
            widget: new RenderedBlockWidget(state.doc.sliceString(from, to), ctx),
            block: true,
          }).range(from, to)
        );
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

/** 块级替换必须来自 StateField；文档、选区或语法树推进时重算。 */
export function blockField(ctx: LiveContext) {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, ctx),
    update(value, tr) {
      return tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? build(tr.state, ctx)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
