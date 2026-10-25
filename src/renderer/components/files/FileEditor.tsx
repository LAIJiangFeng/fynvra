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
    fontSize: '13px',
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
