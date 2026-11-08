import { EditorView, type Extension, Prec } from '@uiw/react-codemirror';
import { blockField } from './blocks';
import { inlinePlugin } from './inline';
import { createLinkOpener } from './links';
import { focusTracking, type LiveContext } from './shared';

export type { LiveContext } from './shared';

const HEADING_SPANS = '.cm-ml-heading span';
const LIVE_THEME = EditorView.theme({
  '&': { fontSize: '0.875rem' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.75' },
  '.cm-content': {
    width: '100%',
    maxWidth: '48rem',
    margin: '0 auto',
    padding: '16px 24px',
  },
  '.cm-line': { padding: '0' },
  '.cm-ml-heading': { fontWeight: '600', lineHeight: '1.5' },
  // 语法高亮给标题加的下划线/颜色在实时预览里不需要。
  [HEADING_SPANS]: { textDecoration: 'none', color: 'inherit' },
  '.cm-ml-h1': { fontSize: '1.25rem', paddingTop: '0.75rem', paddingBottom: '0.25rem' },
  '.cm-ml-h2': { fontSize: '1.125rem', paddingTop: '0.75rem', paddingBottom: '0.125rem' },
  '.cm-ml-h3': { fontSize: '1rem', paddingTop: '0.5rem' },
  '.cm-ml-h4, .cm-ml-h5, .cm-ml-h6': { paddingTop: '0.25rem' },
  '.cm-ml-strong': { fontWeight: '600' },
  '.cm-ml-em': { fontStyle: 'italic' },
  '.cm-ml-strike': { textDecoration: 'line-through' },
  '.cm-ml-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    backgroundColor: 'var(--muted)',
    borderRadius: '4px',
    padding: '0.1em 0.3em',
  },
  '.cm-ml-link, .cm-ml-link span': {
    color: 'var(--primary)',
    fontWeight: '500',
    textDecoration: 'underline',
    textUnderlineOffset: '4px',
  },
  '.cm-ml-quote': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '1rem',
    color: 'var(--muted-foreground)',
  },
  '.cm-ml-codeblock': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8125rem',
    backgroundColor: 'var(--muted)',
    padding: '0 1rem',
  },
  '.cm-ml-fence': { opacity: '0.55' },
  '.cm-ml-bullet': {
    display: 'inline-block',
    minWidth: '0.75em',
    color: 'var(--muted-foreground)',
  },
  '.cm-ml-task': {
    margin: '0 0.4em 0 0',
    verticalAlign: 'middle',
    accentColor: 'var(--primary)',
    cursor: 'pointer',
  },
  '.cm-ml-hr': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
    borderTop: '1px solid var(--border)',
  },
  '.cm-ml-image img': { display: 'inline-block', maxWidth: '100%', verticalAlign: 'middle' },
  '.cm-ml-image-alt': { color: 'var(--muted-foreground)' },
  // 块内容不继承 .cm-lineWrapping 的 white-space: break-spaces，否则 HTML 源码里的换行和缩进会成为空行。
  '.cm-ml-block': {
    padding: '0.25rem 0',
    cursor: 'text',
    minHeight: '1.75em',
    whiteSpace: 'normal',
  },
  '.cm-ml-tr': {
    display: 'grid',
    borderLeft: '1px solid var(--border)',
    whiteSpace: 'normal',
    lineHeight: '1.5',
    cursor: 'text',
  },
  '.cm-ml-tr.cm-ml-tfirst': { borderTop: '1px solid var(--border)' },
  '.cm-ml-tr.cm-ml-th': {
    fontWeight: '600',
    backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)',
  },
  '.cm-ml-td': {
    minWidth: '0',
    padding: '0.375rem 0.75rem',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    overflowWrap: 'anywhere',
  },
  '.cm-ml-tsep': { height: '1px', backgroundColor: 'var(--border)', cursor: 'text' },
  '.cm-line.cm-ml-table-src': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8125rem',
    fontWeight: '400',
    backgroundColor: 'var(--muted)',
    border: '1px solid var(--border)',
    padding: '0.25rem 0.5rem',
  },
  // 语法高亮把表头当标题（粗体+下划线），源码行里不需要。
  '.cm-ml-table-src span': { textDecoration: 'none', fontWeight: 'inherit' },
});

/** Markdown 实时预览：编辑器聚焦时光标所在行显示源码，其余按渲染效果显示；文本本身不被改写。 */
export function markdownLive(ctx: LiveContext): Extension {
  const opener = createLinkOpener(ctx);
  return [
    Prec.highest(LIVE_THEME),
    EditorView.lineWrapping,
    inlinePlugin(ctx, opener),
    focusTracking,
    blockField(ctx, opener),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        const target =
          event.target instanceof Element ? event.target.closest('[data-ml-href]') : null;
        if (!target || !view.contentDOM.contains(target)) return false;
        // 拦截 CodeMirror 默认的 Ctrl/Cmd+点击（添加光标），只打开链接。
        event.preventDefault();
        opener.open(target.getAttribute('data-ml-href') ?? '');
        return true;
      },
    }),
  ];
}
