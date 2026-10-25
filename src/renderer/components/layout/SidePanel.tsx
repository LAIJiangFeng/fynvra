import { useEffect, useState } from 'react';
import { OrchestrationPanel } from '@/components/orchestration/OrchestrationPanel';
import { useT } from '@/i18n/I18nProvider';

const MIN_WIDTH = 288;
const DEFAULT_WIDTH = 360;
const MAX_WIDTH = 960;
/** 最多占窗口宽度的这个比例，给主区域留出空间。 */
const MAX_RATIO = 0.6;
const KEY_STEP = 24;
/** 收起再展开时沿用上次拖到的宽度（只在本次运行内记住）。 */
let preferredWidth = DEFAULT_WIDTH;

function clampWidth(width: number, viewport: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(viewport * MAX_RATIO)));
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), max));
}

/** 右栏：编排面板（任务看板、worker 输出、diff）。左边缘可拖动调宽，双击恢复默认宽度。 */
export function SidePanel() {
  const [preferred, setPreferred] = useState(preferredWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const t = useT();
  const width = clampWidth(preferred, viewport);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const resize = (next: number) => {
    const clamped = clampWidth(next, window.innerWidth);
    preferredWidth = clamped;
    setPreferred(clamped);
  };

  return (
    <aside
      aria-label={t('app.sidePanel')}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 可聚焦、可拖动的分隔条（ARIA window splitter），<hr> 表达不了 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('app.resizeSidePanel')}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title={t('app.resizeSidePanelHint')}
        className="absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-ring/30 focus-visible:bg-ring/40"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const handle = event.currentTarget;
          const startX = event.clientX;
          const startWidth = width;
          handle.setPointerCapture(event.pointerId);
          const move = (moveEvent: PointerEvent) =>
            resize(startWidth + (startX - moveEvent.clientX));
          const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', end);
          handle.addEventListener('pointercancel', end);
        }}
        onDoubleClick={() => resize(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            resize(width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP));
          }
        }}
      />
      <OrchestrationPanel />
    </aside>
  );
}
