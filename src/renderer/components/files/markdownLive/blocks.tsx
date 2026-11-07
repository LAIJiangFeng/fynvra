import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  type DecorationSet,
  type EditorState,
  EditorView,
  type Range,
  StateEffect,
  StateField,
  WidgetType,
} from '@uiw/react-codemirror';
import { type ReactNode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/i18n/I18nProvider';
import { FileMarkdownPreview } from '../FileMarkdownPreview';
import type { LinkOpener } from './links';
import { focusChanged, type LiveContext, lastLine, type SyntaxNode, touches } from './shared';
import { type TableEnv, TableRowWidget, TableRuleWidget, tableModel } from './table';

/** HTML 块渲染后的实际高度（按源码），下次创建同一块时作为 estimatedHeight。 */
const htmlHeights = new Map<string, number>();
const mounted = new WeakMap<
  HTMLElement,
  { root: Root; observer: ResizeObserver; source: string; ctx: LiveContext }
>();
/** 高度表与实际 DOM 不一致时，让 StateField 用新的估算高度重建 HTML 块装饰。 */
const refreshBlocks = StateEffect.define<null>();

function rememberHeight(source: string, height: number) {
  htmlHeights.delete(source);
  htmlHeights.set(source, height);
  if (htmlHeights.size > 200) htmlHeights.delete(htmlHeights.keys().next().value as string);
}

function estimateHtml(source: string): number {
  return htmlHeights.get(source) ?? source.split('\n').length * 24 + 8;
}

/**
 * React 提交或尺寸变化后核对高度。view.requestMeasure() 只有在 contentDOM 总高度变化时才会重新读取
 * 各块高度（ViewState.measure 的 measureContent 判断），内容比编辑器矮时高度表会停在旧值；
 * 因此这里自己比较，不一致就 dispatch refreshBlocks，让该块装饰带着实测高度重建并触发重测。
 */
function syncHeight(view: EditorView, dom: HTMLElement, source: string) {
  view.requestMeasure({
    key: dom,
    read(current) {
      if (!dom.isConnected) return false;
      // 与 measureVisibleLineHeights 一样取 getBoundingClientRect 的高度。
      const height = dom.getBoundingClientRect().height;
      if (height <= 0) return false;
      rememberHeight(source, Math.round(height));
      const block = current.lineBlockAt(current.posAtDOM(dom));
      return Math.abs(block.height - height) > 1;
    },
    write(stale, current) {
      // 测量阶段不能 dispatch，放到微任务里。
      if (stale)
        queueMicrotask(() => {
          if (dom.isConnected) current.dispatch({ effects: refreshBlocks.of(null) });
        });
    },
  });
}

function AfterCommit({ onCommit, children }: { onCommit(): void; children: ReactNode }) {
  // 每次提交后都核对一次高度（不依赖 ResizeObserver 的时机）。
  useLayoutEffect(() => onCommit());
  return children;
}

/**
 * HTML 块的渲染结果：在 widget 内挂一个 React root，复用只读预览的
 * Markdown + HTML_PLUGINS（同一套 sanitize）+ 图片/链接组件。
 */
class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly ctx: LiveContext,
    readonly height: number
  ) {
    super();
  }
  eq(other: RenderedBlockWidget) {
    return other.source === this.source && other.ctx === this.ctx && other.height === this.height;
  }
  /** 只有估算高度变化时：沿用已挂载的 DOM 和 React root，只让编辑器重新测量。 */
  updateDOM(dom: HTMLElement) {
    const entry = mounted.get(dom);
    return !!entry && entry.source === this.source && entry.ctx === this.ctx;
  }
  get estimatedHeight() {
    return this.height;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-ml-block';
    const container = document.createElement('div');
    dom.append(container);
    const { source } = this;
    const root = createRoot(container);
    root.render(
      <AfterCommit onCommit={() => syncHeight(view, dom, source)}>
        <I18nProvider>
          <FileMarkdownPreview
            file={this.ctx.file}
            store={this.ctx.store}
            text={source}
            className=""
          />
        </I18nProvider>
      </AfterCommit>
    );
    // 图片晚到等也会改变高度。
    const observer = new ResizeObserver(() => syncHeight(view, dom, source));
    observer.observe(dom);
    mounted.set(dom, { root, observer, source, ctx: this.ctx });
    // 普通点击把光标移进源码（显示源码）；Ctrl/Cmd+点击交给渲染出的链接。
    dom.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        view.focus();
        view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
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

/** 激活（光标所在）的表格行显示源码，用行装饰保持在表格框内。 */
const SOURCE_ROW = Decoration.line({ class: 'cm-ml-table-src' });

/**
 * 顶层表格逐行处理：激活行显示源码，其余行换成同步构建的行 widget，分隔行换成细线。
 * 块替换都设为 inclusive：非 inclusive 的块替换会在前后各多出一个空行（供光标停靠）。
 */
function addTable(
  state: EditorState,
  table: SyntaxNode,
  env: TableEnv,
  ranges: Range<Decoration>[]
) {
  const { doc } = state;
  const model = tableModel(state, table);
  let index = 0;
  for (let node = table.firstChild; node; node = node.nextSibling, index++) {
    const row = model.rows[index];
    if (!row) break;
    const line = doc.lineAt(node.from);
    if (touches(state, line.from, line.to)) {
      ranges.push(SOURCE_ROW.range(line.from));
      continue;
    }
    const widget =
      row.kind === 'delimiter'
        ? new TableRuleWidget(env)
        : new TableRowWidget(line.text, row, model, index === 0, env);
    ranges.push(
      Decoration.replace({ widget, block: true, inclusive: true }).range(line.from, line.to)
    );
  }
}

/** 只处理顶层的表格和 HTML 块；嵌在引用/列表中的保持源码。 */
function build(state: EditorState, env: TableEnv): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Document') return true;
      if (node.name === 'Table') addTable(state, node.node, env, ranges);
      else if (node.name === 'HTMLBlock' && !touches(state, node.from, node.to)) {
        const from = state.doc.lineAt(node.from).from;
        const to = lastLine(state, node.from, node.to).to;
        const source = state.doc.sliceString(from, to);
        ranges.push(
          Decoration.replace({
            widget: new RenderedBlockWidget(source, env.ctx, estimateHtml(source)),
            block: true,
            inclusive: true,
          }).range(from, to)
        );
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

/** 块级替换必须来自 StateField；文档、选区、焦点或语法树变化时重算。 */
export function blockField(ctx: LiveContext, opener: LinkOpener) {
  const env: TableEnv = { ctx, opener };
  return StateField.define<DecorationSet>({
    create: (state) => build(state, env),
    update(value, tr) {
      return tr.docChanged ||
        tr.selection ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
        focusChanged(tr.startState, tr.state) ||
        tr.effects.some((effect) => effect.is(refreshBlocks))
        ? build(tr.state, env)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
