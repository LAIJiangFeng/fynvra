import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import type { WorkspaceFileEntry } from '@shared/types/files';
import CodeMirror, { EditorView, type Extension, Prec } from '@uiw/react-codemirror';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { type FilesStore, isMarkdown } from '@/stores/files';
import { editorText, fileText } from './editorText';
import { markdownLive } from './markdownLive';

const EDITOR_THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': {
    backgroundColor: 'var(--sidebar)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  // 搜索面板：浅色/深色主题都用应用的 CSS 变量，保证可读。
  '.cm-panels': { backgroundColor: 'var(--sidebar)', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '0.75rem' },
  '.cm-panel.cm-search label': { color: 'var(--foreground)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted-foreground)' },
  '.cm-textfield': {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--muted)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, var(--primary) 20%, transparent)',
    outline: '1px solid color-mix(in oklab, var(--primary) 45%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklab, var(--primary) 40%, transparent)',
  },
});
/** 源码模式（含双栏的编辑器）保持原有外观。 */
const SOURCE_THEME = EditorView.theme({
  '&': { fontSize: '0.8125rem' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  '.cm-content': { padding: '12px 0' },
});
const LIVE_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
};

export default function FileEditor({
  file,
  store,
  live,
  value,
  source,
  onChange,
}: {
  file: WorkspaceFileEntry;
  store: FilesStore;
  /** Markdown 实时预览；与源码/双栏共用同一个编辑器实例，切换只重配扩展。 */
  live: boolean;
  value: string;
  source: string;
  onChange(text: string): void;
}) {
  const { name } = file;
  const markdownFile = isMarkdown(name);
  // Markdown 在所有模式下都用 GFM（表格、删除线、任务列表、裸链接），代码块按语言高亮。
  // 首次渲染就同步提供：先无语言、再整体 reconfigure 会让实时预览先按纯文本排版测量一遍。
  const markdownExtension = useMemo(
    () => (markdownFile ? [markdown({ base: markdownLanguage, codeLanguages: languages })] : null),
    [markdownFile]
  );
  const [loadedLanguage, setLanguage] = useState<Extension[]>([]);
  const language = markdownExtension ?? loadedLanguage;
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const t = useT();
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark'))
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (isMarkdown(name)) {
      setLanguage((current) => (current.length ? [] : current));
      return;
    }
    let canceled = false;
    const extension = name.split('.').at(-1)?.toLowerCase();
    const match =
      languages.find((item) => item.filename?.test(name)) ??
      languages.find((item) => item.extensions.includes(extension ?? ''));
    if (match)
      void match
        .load()
        .then((support) => {
          if (!canceled) setLanguage([support]);
        })
        .catch(() => {
          if (!canceled) setLanguage([]);
        });
    return () => {
      canceled = true;
    };
  }, [name]);

  const linkHint = t('files.liveLinkHint');
  const liveExtension = useMemo(
    () =>
      live
        ? markdownLive({
            file,
            store,
            references: store.getState().markdownReferences(file.id),
            linkHint,
          })
        : [],
    [live, file, store, linkHint]
  );
  const editorLabel = t('files.editor', { name });
  // 扩展保持稳定引用：@uiw/react-codemirror 在引用变化时整体 reconfigure，
  // reconfigure 保留文档、选区和撤销历史（history 字段在新旧配置中都存在）。
  const extensions = useMemo(
    () => [
      Prec.highest(EDITOR_THEME),
      live ? [] : Prec.highest(SOURCE_THEME),
      EditorView.contentAttributes.of({ 'aria-label': editorLabel }),
      ...language,
      liveExtension,
    ],
    [live, editorLabel, language, liveExtension]
  );

  return (
    <CodeMirror
      value={editorText(value)}
      height="100%"
      className="h-full"
      theme={dark ? 'dark' : 'light'}
      basicSetup={live ? LIVE_SETUP : true}
      extensions={extensions}
      onChange={(text) => onChange(fileText(text, source))}
    />
  );
}
