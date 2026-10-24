import { Children, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { CodeBlock } from './CodeBlock';

const REMARK_PLUGINS = [remarkGfm];

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

type CodeElement = ReactElement<{ className?: string; children?: ReactNode }>;

/** 不渲染原始 HTML（react-markdown 默认），链接交给系统浏览器（Main 拦截新窗口） */
function componentsFor(streaming: boolean): Components {
  return {
    pre({ children }) {
      const code = Children.toArray(children).find(isValidElement) as CodeElement | undefined;
      if (!code) return <pre>{children}</pre>;
      const lang = /language-(\S+)/.exec(code.props.className ?? '')?.[1] ?? '';
      const text = textOf(code.props.children).replace(/\n$/, '');
      // 流式中代码还在变，先不高亮，结束后再上色
      return <CodeBlock code={text} lang={lang} highlight={!streaming} />;
    },
    code: ({ className, children }) => (
      <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]', className)}>
        {children}
      </code>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-4"
      >
        {children}
      </a>
    ),
    p: ({ children }) => <p className="my-2 leading-7 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
    li: ({ children }) => <li className="leading-7">{children}</li>,
    h1: ({ children }) => <h1 className="mt-5 mb-3 font-semibold text-xl">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-5 mb-2 font-semibold text-lg">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-4 mb-2 font-semibold text-base">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold">{children}</h4>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 pl-4 text-muted-foreground">{children}</blockquote>
    ),
    hr: () => <hr className="my-4" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children, style }) => (
      <th style={style} className="border bg-muted/50 px-3 py-1.5 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border px-3 py-1.5">
        {children}
      </td>
    ),
  };
}

const STATIC_COMPONENTS = componentsFor(false);
const STREAMING_COMPONENTS = componentsFor(true);

/** GFM Markdown：表格、任务列表、代码块高亮与复制。 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 break-words text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={streaming ? STREAMING_COMPONENTS : STATIC_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
