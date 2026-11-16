import type { Components } from 'react-markdown';
import { Markdown } from '@/components/chat/Markdown';

/** 抽屉里的紧凑排版：聊天 Markdown 的行高、标题和缩进对小字号太松；模块级常量，Markdown 按引用 memo。 */
const COMPACT: Components = {
  p: ({ children }) => <p className="my-1 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1 font-semibold text-[13px] first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 font-semibold text-[13px] first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-2 mb-1 font-semibold text-xs first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 font-semibold text-xs first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2" />,
};

export function CompactMarkdown({ text, className }: { text: string; className?: string }) {
  return <Markdown text={text} className={className} components={COMPACT} />;
}
