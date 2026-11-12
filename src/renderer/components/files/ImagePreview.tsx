import { Minus, Plus } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { clampZoom, useCtrlWheelZoom } from './useCtrlWheelZoom';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const BUTTON_STEP = 1.25;

/** 图片预览：1 = 适合宽度；Ctrl/Cmd + 滚轮以光标为锚点缩放。 */
export default function ImagePreview({ dataUrl, name }: { dataUrl: string; name: string }) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const baseWidth = useRef(0);
  // 缩放后图片内锚点坐标与它在容器视口中的位置，布局后据此回填滚动位置
  const anchor = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [shownUrl, setShownUrl] = useState(dataUrl);
  if (shownUrl !== dataUrl) {
    setShownUrl(dataUrl);
    setZoom(1);
  }

  const zoomTo = (target: number, clientX?: number, clientY?: number) => {
    const img = imgRef.current;
    const box = scrollRef.current;
    if (!img || !box) return;
    const next = clampZoom(target, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom) return;
    if (zoom === 1) baseWidth.current = img.offsetWidth;
    if (!baseWidth.current) return;
    const boxRect = box.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const x = clientX ?? boxRect.left + box.clientWidth / 2;
    const y = clientY ?? boxRect.top + box.clientHeight / 2;
    const ratio = next / zoom;
    anchor.current = {
      x: (x - imgRect.left) * ratio,
      y: (y - imgRect.top) * ratio,
      cx: x - boxRect.left,
      cy: y - boxRect.top,
    };
    setZoom(next);
  };

  useCtrlWheelZoom(scrollRef, (factor, event) =>
    zoomTo(zoom * factor, event.clientX, event.clientY)
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次缩放渲染后回填滚动位置
  useLayoutEffect(() => {
    const point = anchor.current;
    const img = imgRef.current;
    const box = scrollRef.current;
    anchor.current = null;
    if (!point || !img || !box) return;
    box.scrollLeft = img.offsetLeft + point.x - point.cx;
    box.scrollTop = img.offsetTop + point.y - point.cy;
  }, [zoom]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b px-3 py-1 text-muted-foreground text-xs">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('files.document.zoomOut')}
          title={t('files.document.zoomOut')}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => zoomTo(zoom / BUTTON_STEP)}
        >
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 min-w-14 px-2 text-xs tabular-nums"
          title={t('files.document.fitWidth')}
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('files.document.zoomIn')}
          title={t('files.document.zoomIn')}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => zoomTo(zoom * BUTTON_STEP)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto p-6">
        <img
          ref={imgRef}
          src={dataUrl}
          alt={name}
          className="mx-auto max-w-full rounded border bg-muted/30"
          style={zoom === 1 ? undefined : { width: baseWidth.current * zoom, maxWidth: 'none' }}
        />
      </div>
    </div>
  );
}
