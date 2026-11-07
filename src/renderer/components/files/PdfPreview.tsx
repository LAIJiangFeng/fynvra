import { Loader2, Minus, Plus } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { openPdf, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs';

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PAGE_GAP_PX = 32;

interface PageSize {
  width: number;
  height: number;
}

/** 只读 PDF 预览：pdf.js 懒加载，页面连续排列，进入可视区才渲染；默认适合宽度。 */
export default function PdfPreview({ data }: { data: Uint8Array }) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [baseSize, setBaseSize] = useState<PageSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: Awaited<ReturnType<typeof openPdf>> | undefined;
    setDoc(null);
    setBaseSize(null);
    setError(null);
    openPdf(data)
      .then(async (loading) => {
        task = loading;
        if (cancelled) {
          void loading.destroy();
          return;
        }
        const pdf = await loading.promise;
        const first = await pdf.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setBaseSize({ width: viewport.width, height: viewport.height });
        setDoc(pdf);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const fitScale =
    baseSize && width > 0 ? Math.max(0.1, (width - PAGE_GAP_PX) / baseSize.width) : 1;
  const scale = fitScale * zoom;
  const step = (delta: number) => {
    const index = ZOOM_STEPS.findIndex((value) => value >= zoom - 0.001);
    const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + delta))];
    if (next !== undefined) setZoom(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 text-muted-foreground text-xs">
        <span className="flex-1 tabular-nums">
          {doc ? t('files.document.pages', { total: doc.numPages }) : ''}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('files.document.zoomOut')}
          title={t('files.document.zoomOut')}
          disabled={!doc || zoom <= ZOOM_STEPS[0]}
          onClick={() => step(-1)}
        >
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 min-w-14 px-2 text-xs tabular-nums"
          title={t('files.document.fitWidth')}
          disabled={!doc}
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('files.document.zoomIn')}
          title={t('files.document.zoomIn')}
          disabled={!doc || zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          onClick={() => step(1)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        role="document"
        aria-label={t('files.document.pdfPreview')}
        className="min-h-0 flex-1 overflow-auto bg-muted/40 py-4"
      >
        {error ? (
          <p role="alert" className="p-6 text-center text-muted-foreground text-sm">
            {t('files.document.parseFailed', { message: error })}
          </p>
        ) : !doc || !baseSize ? (
          <div role="status" className="flex justify-center p-6">
            <Loader2 className="size-6 animate-spin text-muted-foreground opacity-60" />
          </div>
        ) : (
          <div className="flex w-max min-w-full flex-col items-center gap-4 px-4">
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: 页码即稳定标识
                key={index}
                doc={doc}
                pageNumber={index + 1}
                scale={scale}
                fallback={baseSize}
                rootRef={scrollRef}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  fallback,
  rootRef,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  fallback: PageSize;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { root: rootRef.current, rootMargin: '100% 0px' }
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [rootRef]);

  useEffect(() => {
    if (!visible || page) return;
    let cancelled = false;
    doc
      .getPage(pageNumber)
      .then((loaded) => {
        if (!cancelled) setPage(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, visible, page]);

  const viewport = page?.getViewport({ scale });
  const size = viewport
    ? { width: viewport.width, height: viewport.height }
    : { width: fallback.width * scale, height: fallback.height * scale };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    if (!visible) {
      // 离开可视区释放位图内存，再次进入时重绘。
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const renderViewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    const task = page.render({ canvas, viewport: renderViewport });
    task.promise.catch((reason: unknown) => {
      if ((reason as { name?: string } | null)?.name !== 'RenderingCancelledException')
        setFailed(true);
    });
    return () => task.cancel();
  }, [page, scale, visible]);

  return (
    <div
      ref={boxRef}
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/10"
      style={{ width: size.width, height: size.height }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t('files.document.page', { page: pageNumber })}
        className="block size-full"
      />
      {failed && (
        <p className="absolute inset-0 m-auto h-fit text-center text-muted-foreground text-xs">
          {t('files.document.parseFailed', { message: `#${pageNumber}` })}
        </p>
      )}
    </div>
  );
}
