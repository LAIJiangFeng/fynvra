import { languages } from '@codemirror/language-data';
import CodeMirror, { EditorView, type Extension, Prec } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { editorText, fileText } from './editorText';

const EDITOR_THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: '0.8125rem',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
  '.cm-content': { padding: '12px 0' },
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

export default function FileEditor({
  name,
  value,
  source,
  onChange,
}: {
  name: string;
  value: string;
  source: string;
  onChange(text: string): void;
}) {
  const [language, setLanguage] = useState<Extension[]>([]);
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

  return (
    <CodeMirror
      value={editorText(value)}
      height="100%"
      className="h-full"
      theme={dark ? 'dark' : 'light'}
      extensions={[
        Prec.highest(EDITOR_THEME),
        EditorView.contentAttributes.of({ 'aria-label': t('files.editor', { name }) }),
        ...language,
      ]}
      onChange={(text) => onChange(fileText(text, source))}
    />
  );
}
