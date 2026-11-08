import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'del',
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
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan'];
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i;

/** 与 FileMarkdownPreview 一致：只有 http(s) 外链保留（交给系统浏览器），其余链接去掉 href。 */
function externalLink(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    return new URL(href).href;
  } catch {
    return null;
  }
}

async function convert(data: Uint8Array): Promise<DocumentFragment> {
  const [{ default: mammoth }, { default: createDOMPurify }] = await Promise.all([
    import('mammoth'),
    import('dompurify'),
  ]);
  // 复制到独立 ArrayBuffer，避免 byteOffset 视图把多余字节交给解析器。
  const arrayBuffer = data.slice().buffer;
  const { value } = await mammoth.convertToHtml(
    { arrayBuffer },
    { convertImage: mammoth.images.dataUri, externalFileAccess: false }
  );
  // 独立实例，钩子不影响其他使用 DOMPurify 的地方。
  const purify = createDOMPurify(window);
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      const external = externalLink(node.getAttribute('href') ?? '');
      if (external) {
        node.setAttribute('href', external);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer');
      } else {
        node.removeAttribute('href');
      }
    } else if (node.nodeName === 'IMG' && !DATA_IMAGE.test(node.getAttribute('src') ?? '')) {
      // 不加载任何外部资源：只保留内嵌的 data: 图片。
      node.removeAttribute('src');
    }
  });
  return purify.sanitize(value, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
}

/** 只读 DOCX 预览：mammoth 转 HTML，经 DOMPurify 白名单过滤后放入容器，不执行文档内任何脚本。 */
export default function DocxPreview({ data }: { data: Uint8Array }) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    contentRef.current?.replaceChildren();
    convert(data)
      .then((fragment) => {
        if (cancelled) return;
        contentRef.current?.replaceChildren(fragment);
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setState({ error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <>
      {state === 'loading' && (
        <div role="status" className="flex justify-center p-6">
          <Loader2 className="size-6 animate-spin text-muted-foreground opacity-60" />
        </div>
      )}
      {typeof state === 'object' && (
        <p role="alert" className="p-6 text-center text-muted-foreground text-sm">
          {t('files.document.parseFailed', { message: state.error })}
        </p>
      )}
      <div
        ref={contentRef}
        className={cn(
          'mx-auto max-w-3xl break-words text-sm leading-relaxed',
          '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:font-semibold [&_h1]:text-2xl',
          '[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:font-semibold [&_h2]:text-xl',
          '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold [&_h3]:text-lg',
          '[&_h4,&_h5,&_h6]:mt-4 [&_h4,&_h5,&_h6]:mb-2 [&_h4,&_h5,&_h6]:font-semibold',
          '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6',
          '[&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
          '[&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1',
          '[&_img]:inline-block [&_img]:max-w-full',
          '[&_a[href]]:font-medium [&_a[href]]:text-primary [&_a[href]]:underline [&_a[href]]:underline-offset-4',
          state !== 'ready' && 'hidden'
        )}
      />
    </>
  );
}
