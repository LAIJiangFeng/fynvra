import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type Range,
  ViewPlugin,
  type ViewUpdate,
} from '@uiw/react-codemirror';
import { type LinkOpener, linkTarget } from './links';
import { type LiveContext, type SyntaxNode, touches } from './shared';
import { BulletWidget, ImageWidget, RuleWidget, TaskWidget } from './widgets';

const HIDDEN = Decoration.replace({});
const BULLET = Decoration.replace({ widget: new BulletWidget() });
const RULE = Decoration.replace({ widget: new RuleWidget() });
const CHECKED = Decoration.replace({ widget: new TaskWidget(true) });
const UNCHECKED = Decoration.replace({ widget: new TaskWidget(false) });
const HEADINGS = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-ml-heading cm-ml-h${level}` })
);
const QUOTE_LINE = Decoration.line({ class: 'cm-ml-quote' });
const CODE_LINE = Decoration.line({ class: 'cm-ml-codeblock' });
const FENCE_LINE = Decoration.line({ class: 'cm-ml-fence' });
const STYLES: Record<string, { mark: string; deco: Decoration }> = {
  Emphasis: { mark: 'EmphasisMark', deco: Decoration.mark({ class: 'cm-ml-em' }) },
  StrongEmphasis: { mark: 'EmphasisMark', deco: Decoration.mark({ class: 'cm-ml-strong' }) },
  Strikethrough: { mark: 'StrikethroughMark', deco: Decoration.mark({ class: 'cm-ml-strike' }) },
  InlineCode: { mark: 'CodeMark', deco: Decoration.mark({ class: 'cm-ml-code' }) },
};
/** 这些父节点自己处理内部的 URL，不按 GFM 裸链接处理。 */
const URL_OWNERS = new Set(['Link', 'Image', 'Autolink', 'LinkReference']);

function isSpace(text: string): boolean {
  return text === ' ' || text === '\t';
}

/** 只计算可见区域的行内装饰；块级替换（表格、HTML 块）在 blocks.tsx 的 StateField 中。 */
function build(view: EditorView, ctx: LiveContext): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const visible = view.visibleRanges;
  if (!visible.length) return Decoration.none;
  // 块级替换会把可见区拆成多段；合并成一段遍历，避免跨段节点被重复装饰。
  const viewFrom = visible[0].from;
  const viewTo = visible[visible.length - 1].to;
  const ranges: Range<Decoration>[] = [];
  // 行内替换不能跨行（ViewPlugin 不允许替换换行符）。
  const hide = (from: number, to: number, deco = HIDDEN) => {
    if (from < to && doc.lineAt(from).number === doc.lineAt(to).number)
      ranges.push(deco.range(from, to));
  };
  const lines = (from: number, to: number, deco: Decoration) => {
    const first = doc.lineAt(Math.max(from, viewFrom)).number;
    const last = doc.lineAt(Math.min(Math.max(from, to - 1), viewTo)).number;
    for (let number = first; number <= last; number++)
      ranges.push(deco.range(doc.line(number).from));
  };
  const link = (from: number, to: number, href: string) => {
    if (from < to)
      ranges.push(
        Decoration.mark({
          class: 'cm-ml-link',
          attributes: { 'data-ml-href': href, title: ctx.linkHint },
        }).range(from, to)
      );
  };
  syntaxTree(state).iterate({
    from: viewFrom,
    to: viewTo,
    enter: (ref) => {
      const { name, from, to } = ref;
      const node: SyntaxNode = ref.node;
      const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        const deco = HEADINGS[Number(heading[2]) - 1];
        const marks = node.getChildren('HeaderMark');
        if (heading[1] === 'Setext') {
          // Setext 标题只加样式：下划线行淡化显示。
          const underline = marks.at(-1);
          lines(from, underline ? doc.lineAt(underline.from).from : to, deco);
          if (underline) lines(underline.from, underline.to, FENCE_LINE);
          return;
        }
        lines(from, to, deco);
        if (touches(state, from, to)) return;
        for (const mark of marks) {
          if (mark.from === from) {
            let end = mark.to;
            while (end < to && isSpace(doc.sliceString(end, end + 1))) end++;
            hide(mark.from, end);
          } else {
            let start = mark.from;
            while (start > from && isSpace(doc.sliceString(start - 1, start))) start--;
            hide(start, mark.to);
          }
        }
        return;
      }
      const style = STYLES[name];
      if (style) {
        ranges.push(style.deco.range(from, to));
        if (!touches(state, from, to))
          for (const mark of node.getChildren(style.mark)) hide(mark.from, mark.to);
        return;
      }
      switch (name) {
        case 'Link': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          // 引用式链接和 [foo] 这类没有目标的方括号保持源码。
          if (!url || marks.length < 2) return;
          link(marks[0].to, marks[1].from, linkTarget(doc.sliceString(url.from, url.to)));
          if (!touches(state, from, to)) {
            hide(from, marks[0].to);
            hide(marks[1].from, to);
          }
          return;
        }
        case 'Image': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url || marks.length < 2 || touches(state, from, to)) return false;
          const title = node.getChild('LinkTitle');
          hide(
            from,
            to,
            Decoration.replace({
              widget: new ImageWidget(
                linkTarget(doc.sliceString(url.from, url.to)),
                doc.sliceString(marks[0].to, marks[1].from),
                title ? doc.sliceString(title.from + 1, title.to - 1) : undefined,
                ctx.references
              ),
            })
          );
          return false;
        }
        case 'Autolink': {
          const url = node.getChild('URL');
          if (!url) return false;
          link(url.from, url.to, linkTarget(doc.sliceString(url.from, url.to)));
          if (!touches(state, from, to))
            for (const mark of node.getChildren('LinkMark')) hide(mark.from, mark.to);
          return false;
        }
        case 'URL':
          if (!URL_OWNERS.has(node.parent?.name ?? ''))
            link(from, to, linkTarget(doc.sliceString(from, to), true));
          return;
        case 'ListMark': {
          const item = node.parent;
          // 有序列表保留数字。
          if (item?.parent?.name !== 'BulletList' || touches(state, from, to)) return;
          if (item.getChild('Task')) {
            // 任务项只显示复选框，隐藏列表符号及其后的空格。
            hide(from, isSpace(doc.sliceString(to, to + 1)) ? to + 1 : to);
          } else {
            hide(from, to, BULLET);
          }
          return;
        }
        case 'TaskMarker':
          if (!touches(state, from, to))
            hide(from, to, /^\[[xX]\]$/.test(doc.sliceString(from, to)) ? CHECKED : UNCHECKED);
          return;
        case 'Blockquote':
          lines(from, to, QUOTE_LINE);
          return;
        case 'QuoteMark':
          if (!touches(state, from, to))
            hide(from, isSpace(doc.sliceString(to, to + 1)) ? to + 1 : to);
          return;
        case 'HorizontalRule':
          if (!touches(state, from, to)) hide(from, to, RULE);
          return false;
        case 'FencedCode':
        case 'CodeBlock':
          lines(from, to, CODE_LINE);
          for (const mark of node.getChildren('CodeMark')) lines(mark.from, mark.to, FENCE_LINE);
          return false;
        case 'Table':
        case 'HTMLBlock':
          return false;
      }
      return undefined;
    },
  });
  return Decoration.set(ranges, true);
}

export function inlinePlugin(ctx: LiveContext, opener: LinkOpener) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, ctx);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) opener.cancel();
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = build(update.view, ctx);
      }
      destroy() {
        opener.cancel();
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}
