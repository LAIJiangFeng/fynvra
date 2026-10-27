import type { WorkspaceFileEntry } from '@shared/types/files';
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import type { Components, Options } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { type Options as SanitizeOptions } from 'rehype-sanitize';
import { Markdown } from '@/components/chat/Markdown';
import type { MarkdownReferences } from '@/lib/markdownPreview';
import type { FilesStore } from '@/stores/files';

const ALIGN: [string, string, string, string] = ['align', 'left', 'center', 'right'];
const HTML_SCHEMA: SanitizeOptions = {
  tagNames: [
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'dd',
    'del',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'input',
    'ins',
    'kbd',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tfoot',
    'tr',
    'ul',
  ],
  attributes: {
    '*': ['title'],
    a: ['href'],
    code: [['className', /^language-./]],
    h1: [ALIGN],
    h2: [ALIGN],
    h3: [ALIGN],
    h4: [ALIGN],
    p: [ALIGN],
    th: [ALIGN],
    td: [ALIGN],
    img: ['src', 'alt', 'width', 'height'],
    input: [
      ['type', 'checkbox'],
      ['disabled', true],
      ['checked', true],
    ],
  },
  // 相对引用仍需经下方的 Renderer 解析器验证；任何文档内 data URL 都不允许。
  protocols: { href: ['http', 'https'], src: ['http', 'https'] },
  required: { input: { type: 'checkbox', disabled: true } },
  strip: [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'form',
    'textarea',
    'select',
    'button',
    'template',
    'noscript',
    'link',
    'meta',
    'base',
    'head',
    'title',
  ],
};
// 顺序不可交换：先解析 HTML，再过滤整个 HAST（包括普通 Markdown 产生的节点）。
const HTML_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, HTML_SCHEMA]];
const LINK_CLASS = 'font-medium text-primary underline underline-offset-4';

function externalLink(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    return new URL(href).href;
  } catch {
    return null;
  }
}

export function FileMarkdownPreview({
  file,
  store,
  text,
}: {
  file: WorkspaceFileEntry;
  store: FilesStore;
  text: string;
}) {
  const references = useMemo(() => store.getState().markdownReferences(file.id), [store, file]);
  const pendingLink = useRef<symbol | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 源目录或文档内容变化时主动取消待处理的链接点击。
  useEffect(() => {
    // 编辑内容、重命名、切换源文件或卸载后，晚到的点击解析不能打开文件。
    return () => {
      pendingLink.current = null;
    };
  }, [references, text]);

  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt, title, width, height }) => (
        <LocalImage
          references={references}
          src={src}
          alt={alt}
          title={title}
          width={width}
          height={height}
        />
      ),
      a: ({ href, children, title }) => {
        const external = href ? externalLink(href) : null;
        if (external) {
          return (
            <a
              href={external}
              target="_blank"
              rel="noreferrer"
              title={title}
              className={LINK_CLASS}
            >
              {children}
            </a>
          );
        }
        if (!href || !references.isLocal(href)) return <span title={title}>{children}</span>;
        // 本地引用没有浏览器 href，辅助点击/上下文菜单也无法导航 Electron 窗口。
        return (
          <button
            type="button"
            title={title}
            className={LINK_CLASS}
            onClick={async () => {
              const request = Symbol();
              pendingLink.current = request;
              const entry = await references.resolveFile(href);
              const state = store.getState();
              if (
                entry &&
                pendingLink.current === request &&
                state.selectedId === file.id &&
                state.opened.some(
                  (source) => source.id === file.id && source.relativePath === file.relativePath
                )
              )
                void state.openFile(entry);
            }}
          >
            {children}
          </button>
        );
      },
    }),
    [references, file, store]
  );

  return (
    <Markdown
      text={text}
      className="mx-auto max-w-3xl"
      rehypePlugins={HTML_PLUGINS}
      components={components}
    />
  );
}

function dimension(value: string | number | undefined): number | undefined {
  const parsed =
    typeof value === 'number' ? value : value && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 4096 ? parsed : undefined;
}

function LocalImage({
  references,
  src,
  alt,
  title,
  width,
  height,
}: Pick<ComponentProps<'img'>, 'src' | 'alt' | 'title' | 'width' | 'height'> & {
  references: MarkdownReferences;
}) {
  const [loaded, setLoaded] = useState<{
    references: MarkdownReferences;
    src: typeof src;
    dataUrl: string | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void references.readImage(typeof src === 'string' ? src : '').then((dataUrl) => {
      if (current) setLoaded({ references, src, dataUrl });
    });
    return () => {
      current = false;
    };
  }, [references, src]);

  // 即便 effect 尚未清理，也绝不显示另一个文件/工作区或上一个 src 的响应。
  const dataUrl = loaded?.references === references && loaded.src === src ? loaded.dataUrl : null;
  if (!dataUrl)
    return (
      <span title={title} className="text-muted-foreground">
        {alt}
      </span>
    );
  const imageWidth = dimension(width);
  const imageHeight = dimension(height);
  return (
    <img
      src={dataUrl}
      alt={alt ?? ''}
      title={title}
      width={imageWidth}
      height={imageHeight}
      style={{ width: imageWidth, height: imageHeight ?? 'auto' }}
      className="inline-block max-w-full align-middle"
      onError={() => setLoaded((current) => (current?.dataUrl === dataUrl ? null : current))}
    />
  );
}
