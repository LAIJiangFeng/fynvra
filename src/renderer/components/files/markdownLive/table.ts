import { type EditorState, type EditorView, WidgetType } from '@uiw/react-codemirror';
import { type LinkOpener, linkTarget } from './links';
import type { LiveContext, SyntaxNode } from './shared';

/** 单元格内容的纯数据形式：toDOM 时只用 createElement / 文本节点构建，不经过 HTML 解析。 */
type Inline =
  | string
  | { tag: 'br' }
  | { tag: 'code' | 'alt'; text: string }
  | { tag: 'strong' | 'em' | 'del'; children: Inline[] }
  | { tag: 'link'; href: string; children: Inline[] };

type Align = '' | 'left' | 'center' | 'right';

export interface TableRow {
  kind: 'header' | 'delimiter' | 'body';
  cells: Inline[][];
  /** 估算高度（px），作为 widget 的 estimatedHeight。 */
  height: number;
}

export interface TableModel {
  /** 与 Table 子节点（表头、分隔行、数据行）一一对应。 */
  rows: TableRow[];
  /** 列模板 + 对齐；同一张表的所有行 widget 共用，eq 时比较它。 */
  layout: string;
  template: string;
  aligns: Align[];
}

export interface TableEnv {
  ctx: LiveContext;
  opener: LinkOpener;
}

const URL_OWNERS = new Set(['Link', 'Image', 'Autolink', 'LinkReference']);
const STYLE_TAGS: Record<string, 'strong' | 'em' | 'del'> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'del',
};
const STYLE_CLASSES = { strong: 'cm-ml-strong', em: 'cm-ml-em', del: 'cm-ml-strike' };
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};
/** 单元格行高与上下内边距（px），只用于估算高度。 */
const CELL_LINE = 21;
const CELL_PADDING = 13;
/** 内容区约 48rem，按 ch 估算一行能放下的字符宽度。 */
const ROW_CHARS = 96;

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out.at(-1);
  if (typeof last === 'string') out[out.length - 1] = last + text;
  else out.push(text);
}

function entity(raw: string): string {
  const named = /^&([a-z]+);$/i.exec(raw);
  if (named) return ENTITIES[named[1].toLowerCase()] ?? raw;
  const numeric = /^&#(x[0-9a-f]+|[0-9]+);$/i.exec(raw);
  if (!numeric) return raw;
  const code =
    numeric[1][0].toLowerCase() === 'x'
      ? Number.parseInt(numeric[1].slice(1), 16)
      : Number.parseInt(numeric[1], 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
}

/** 按实时预览的行内规则把 [from, to) 内的语法树转成 Inline；未识别的节点按原文显示。 */
function inlines(state: EditorState, node: SyntaxNode, from: number, to: number): Inline[] {
  const { doc } = state;
  const out: Inline[] = [];
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue;
    if (child.from >= to) break;
    pushText(out, doc.sliceString(pos, child.from));
    pos = Math.min(child.to, to);
    const { name } = child;
    const style = STYLE_TAGS[name];
    if (style) {
      out.push({ tag: style, children: inlines(state, child, child.from, child.to) });
      continue;
    }
    switch (name) {
      case 'InlineCode': {
        const marks = child.getChildren('CodeMark');
        let text =
          marks.length >= 2
            ? doc.sliceString(marks[0].to, marks[marks.length - 1].from)
            : doc.sliceString(child.from, child.to);
        if (/^ .*[^ ].* $/s.test(text)) text = text.slice(1, -1);
        // GFM：表格里代码中的 \| 显示为 |。
        out.push({ tag: 'code', text: text.replace(/\\\|/g, '|') });
        break;
      }
      case 'Link': {
        const url = child.getChild('URL');
        const marks = child.getChildren('LinkMark');
        if (url && marks.length >= 2)
          out.push({
            tag: 'link',
            href: linkTarget(doc.sliceString(url.from, url.to)),
            children: inlines(state, child, marks[0].to, marks[1].from),
          });
        else pushText(out, doc.sliceString(child.from, child.to));
        break;
      }
      case 'Image': {
        const marks = child.getChildren('LinkMark');
        out.push({
          tag: 'alt',
          text:
            marks.length >= 2
              ? doc.sliceString(marks[0].to, marks[1].from)
              : doc.sliceString(child.from, child.to),
        });
        break;
      }
      case 'Autolink': {
        const url = child.getChild('URL');
        if (!url) {
          pushText(out, doc.sliceString(child.from, child.to));
          break;
        }
        const text = doc.sliceString(url.from, url.to);
        out.push({ tag: 'link', href: linkTarget(text), children: [text] });
        break;
      }
      case 'URL': {
        const text = doc.sliceString(child.from, child.to);
        if (URL_OWNERS.has(node.name)) pushText(out, text);
        else out.push({ tag: 'link', href: linkTarget(text, true), children: [text] });
        break;
      }
      case 'Escape':
        pushText(out, doc.sliceString(child.from + 1, child.to));
        break;
      case 'Entity':
        pushText(out, entity(doc.sliceString(child.from, child.to)));
        break;
      case 'HTMLTag': {
        const text = doc.sliceString(child.from, child.to);
        if (/^<br\s*\/?>$/i.test(text)) out.push({ tag: 'br' });
        else pushText(out, text);
        break;
      }
      default:
        // 强调/删除线/链接的标记符号不显示；其他节点按其内容继续展开。
        if (!name.endsWith('Mark'))
          for (const item of inlines(state, child, child.from, child.to)) {
            if (typeof item === 'string') pushText(out, item);
            else out.push(item);
          }
    }
  }
  pushText(out, doc.sliceString(pos, to));
  return out;
}

function plain(items: Inline[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item === 'string') text += item;
    else if ('text' in item) text += item.text;
    else if ('children' in item) text += plain(item.children);
  }
  return text;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 显示宽度：中日韩（全角）字符按 2 计。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

/** 与 @lezer/markdown 的 parseRow 相同的切分：只按未转义的 | 分格，空单元格也占一列。 */
function rowCells(row: SyntaxNode): (SyntaxNode | null)[] {
  const cells: (SyntaxNode | null)[] = [];
  let first = true;
  let pending: SyntaxNode | null = null;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') {
      if (!first || pending) cells.push(pending);
      first = false;
      pending = null;
    } else if (child.name === 'TableCell') {
      pending = child;
    }
  }
  if (pending) cells.push(pending);
  return cells;
}

function delimiterAligns(text: string): Align[] {
  return text
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => {
      const spec = cell.trim();
      const left = spec.startsWith(':');
      const right = spec.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
}

function buildModel(state: EditorState, table: SyntaxNode): TableModel {
  const { doc } = state;
  const raw: { kind: TableRow['kind']; cells: Inline[][] }[] = [];
  let aligns: Align[] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name === 'TableDelimiter') {
      aligns = delimiterAligns(doc.lineAt(row.from).text);
      raw.push({ kind: 'delimiter', cells: [] });
    } else if (row.name === 'TableHeader' || row.name === 'TableRow') {
      raw.push({
        kind: row.name === 'TableHeader' ? 'header' : 'body',
        cells: rowCells(row).map((cell) => (cell ? inlines(state, cell, cell.from, cell.to) : [])),
      });
    }
  }
  const columns = Math.max(1, raw.find((row) => row.kind === 'header')?.cells.length ?? 1);
  // GFM：多出的单元格丢弃，缺少的补空。
  for (const row of raw)
    if (row.kind !== 'delimiter')
      row.cells = Array.from({ length: columns }, (_, index) => row.cells[index] ?? []);
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      1,
      ...raw.map((row) => (row.kind === 'delimiter' ? 0 : displayWidth(plain(row.cells[column]))))
    )
  );
  // 列宽按内容宽度分配（fr 与宽度成正比，上下限避免极端比例）；最小宽度够放下短内容，
  // 但不超过平均份额，保证整行不溢出内容区。
  const flex = widths.map((width) => Math.min(Math.max(width, 3), 60));
  const share = Math.floor(100 / columns);
  const template = widths
    .map(
      (width, column) =>
        `minmax(min(calc(${Math.min(width, 16)}ch + 1.5rem), ${share}%), ${flex[column]}fr)`
    )
    .join(' ');
  const total = flex.reduce((sum, value) => sum + value, 0);
  const capacity = flex.map((value) => Math.max(4, (ROW_CHARS * value) / total - 3));
  aligns = Array.from({ length: columns }, (_, column) => aligns[column] ?? '');
  return {
    rows: raw.map((row) => ({
      ...row,
      height:
        row.kind === 'delimiter'
          ? 1
          : CELL_PADDING +
            CELL_LINE *
              Math.max(
                1,
                ...row.cells.map((cell, column) =>
                  Math.ceil(displayWidth(plain(cell)) / capacity[column])
                )
              ),
    })),
    layout: `${template}|${aligns.join(',')}`,
    template,
    aligns,
  };
}

const models = new Map<string, TableModel>();

/** 按表格源码缓存：选区移动时 StateField 会重建装饰，表格本身没变就不必重新解析。 */
export function tableModel(state: EditorState, table: SyntaxNode): TableModel {
  const source = state.doc.sliceString(table.from, table.to);
  let model = models.get(source);
  if (!model) {
    model = buildModel(state, table);
    if (models.size >= 64) models.delete(models.keys().next().value as string);
    models.set(source, model);
  }
  return model;
}

function appendInlines(parent: HTMLElement, items: Inline[], hint: string) {
  for (const item of items) {
    if (typeof item === 'string') {
      parent.append(document.createTextNode(item));
      continue;
    }
    switch (item.tag) {
      case 'br':
        parent.append(document.createElement('br'));
        break;
      case 'code':
      case 'alt': {
        const element = document.createElement('span');
        element.className = item.tag === 'code' ? 'cm-ml-code' : 'cm-ml-image-alt';
        element.textContent = item.text;
        parent.append(element);
        break;
      }
      case 'link': {
        const element = document.createElement('span');
        element.className = 'cm-ml-link';
        element.setAttribute('data-ml-href', item.href);
        element.title = hint;
        appendInlines(element, item.children, hint);
        parent.append(element);
        break;
      }
      default: {
        const element = document.createElement('span');
        element.className = STYLE_CLASSES[item.tag];
        appendInlines(element, item.children, hint);
        parent.append(element);
      }
    }
  }
}

/**
 * 普通点击把光标放到该行行首（只展开这一行）；Ctrl/Cmd+点击打开单元格里的链接。
 * widget 的 ignoreEvent 为 true，编辑器的 domEventHandlers 收不到这里的事件，所以在此处理。
 */
function handlePointer(dom: HTMLElement, view: EditorView, env: TableEnv) {
  dom.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const target =
        event.target instanceof Element ? event.target.closest('[data-ml-href]') : null;
      if (target) env.opener.open(target.getAttribute('data-ml-href') ?? '');
      return;
    }
    view.focus();
    view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
  });
}

/** 表格的一行：toDOM 同步构建完整内容，测量时高度已经确定。 */
export class TableRowWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly row: TableRow,
    readonly table: TableModel,
    readonly first: boolean,
    readonly env: TableEnv
  ) {
    super();
  }
  eq(other: TableRowWidget) {
    return (
      other.source === this.source &&
      other.row.kind === this.row.kind &&
      other.table.layout === this.table.layout &&
      other.first === this.first &&
      other.env === this.env
    );
  }
  get estimatedHeight() {
    return this.row.height;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-ml-tr';
    if (this.row.kind === 'header') dom.classList.add('cm-ml-th');
    if (this.first) dom.classList.add('cm-ml-tfirst');
    dom.style.gridTemplateColumns = this.table.template;
    this.row.cells.forEach((cell, column) => {
      const element = document.createElement('div');
      element.className = 'cm-ml-td';
      const align = this.table.aligns[column];
      if (align) element.style.textAlign = align;
      appendInlines(element, cell, this.env.ctx.linkHint);
      dom.append(element);
    });
    handlePointer(dom, view, this.env);
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

/** 分隔行（|---|）非激活时只显示一条细线。 */
export class TableRuleWidget extends WidgetType {
  constructor(readonly env: TableEnv) {
    super();
  }
  eq(other: TableRuleWidget) {
    return other.env === this.env;
  }
  get estimatedHeight() {
    return 1;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-ml-tsep';
    handlePointer(dom, view, this.env);
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}
