import { type CSSProperties, useEffect, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import { useT } from '@/i18n/I18nProvider';
import { CopyButton } from './CopyButton';
import { highlight, peekHighlighted } from './highlighter';

/** 异步高亮；有缓存时首帧就是高亮结果。`enabled` 为 false（流式中）时只显示纯文本。 */
function useHighlighted(code: string, lang: string, enabled: boolean): ThemedToken[][] | null {
  const [result, setResult] = useState(() => ({ code, lang, tokens: peekHighlighted(code, lang) }));
  const tokens =
    result.code === code && result.lang === lang ? result.tokens : peekHighlighted(code, lang);

  useEffect(() => {
    if (!enabled || tokens) return;
    let cancelled = false;
    highlight(code, lang).then(
      (next) => {
        if (!cancelled && next) setResult({ code, lang, tokens: next });
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [code, lang, enabled, tokens]);

  return tokens;
}

/** 每行的起始偏移作 key：严格递增，不依赖数组下标 */
function linesOf(code: string, tokens: ThemedToken[][]) {
  const texts = code.split(/\r\n|\r|\n/);
  let start = 0;
  return tokens.map((line, index) => {
    const entry = { start, line };
    start += (texts[index]?.length ?? 0) + 1;
    return entry;
  });
}

/** 代码块：语言标签 + 复制按钮，shiki 双主题配色（颜色走 --shiki-light / --shiki-dark）。 */
export function CodeBlock({
  code,
  lang,
  highlight: enabled = true,
}: {
  code: string;
  lang: string;
  highlight?: boolean;
}) {
  const tokens = useHighlighted(code, lang, enabled);
  const t = useT();

  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex h-8 items-center justify-between border-b bg-muted/50 pr-1 pl-3">
        <span className="font-mono text-muted-foreground text-xs">{lang || 'text'}</span>
        <CopyButton text={code} label={t('chat.copyCode')} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed [&_span]:text-(--shiki-light) dark:[&_span]:text-(--shiki-dark)">
        <code>
          {tokens
            ? linesOf(code, tokens).map(({ start, line }) => (
                <span key={start}>
                  {start > 0 && '\n'}
                  {line.map((token) => (
                    <span key={token.offset} style={token.htmlStyle as CSSProperties}>
                      {token.content}
                    </span>
                  ))}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
