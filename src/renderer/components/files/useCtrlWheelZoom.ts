import { type RefObject, useEffect, useRef } from 'react';

export const clampZoom = (zoom: number, min: number, max: number) =>
  Math.min(max, Math.max(min, zoom));

/**
 * Ctrl/Cmd + 滚轮（Chromium 把触控板捏合也报成 ctrlKey 的 wheel）→ 乘法缩放因子。
 * 必须非 passive 并 preventDefault，否则会触发整窗页面缩放；普通滚轮不拦截。
 */
export function attachCtrlWheelZoom(
  target: EventTarget,
  onZoom: (factor: number, event: WheelEvent) => void
): () => void {
  const listener = (event: Event) => {
    const wheel = event as WheelEvent;
    if (!wheel.ctrlKey && !wheel.metaKey) return;
    wheel.preventDefault();
    onZoom(Math.exp(-wheel.deltaY * 0.002), wheel);
  };
  target.addEventListener('wheel', listener, { passive: false });
  return () => target.removeEventListener('wheel', listener);
}

export function useCtrlWheelZoom(
  ref: RefObject<HTMLElement | null>,
  onZoom: (factor: number, event: WheelEvent) => void
) {
  const latest = useRef(onZoom);
  latest.current = onZoom;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return attachCtrlWheelZoom(element, (factor, event) => latest.current(factor, event));
  }, [ref]);
}
