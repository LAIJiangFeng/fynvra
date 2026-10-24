import { type RefObject, useEffect, useState } from 'react';

/** 每隔 `intervalMs` 更新一次的当前时间；`enabled` 为 false 时不起定时器。 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/** 元素第一次接近视口（`rootMargin` 以内）后变为 true 并保持：长 diff 按文件懒渲染。 */
export function useSeenOnce(ref: RefObject<Element | null>, rootMargin = '600px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}
