import { type RefObject, useLayoutEffect, useRef } from 'react';

/**
 * 输入框里的灰字建议层：不进入 textarea 的值，只是同字体的覆盖层。
 * - 已输入的前缀透明（textarea 自己显示），只画剩余的灰字；没有前缀时画整句。
 * - pointer-events-none、aria-hidden：不挡点击，也不会被读屏重复读；可访问提示在 Composer 的 live region。
 * - 随 textarea 的滚动、宽高同步；textarea 在它上面（背后透明），光标和选区不会被盖住。
 */
export function ReplySuggestionGhost({
  textarea,
  draft,
  suffix,
  visible,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  suffix: string;
  visible: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  // 每次渲染都重新同步一次：草稿变长 / 换行会改变 textarea 的宽高与换行，滚动 / 窗口缩放也在这里重挂监听
  useLayoutEffect(() => {
    if (!visible) return;
    const input = textarea.current;
    const outer = box.current;
    const inner = layer.current;
    if (!input || !outer || !inner) return;
    const sync = () => {
      // 宽度对齐 textarea 的实际换行宽度；高度先按内容量，再同步给 textarea，避免长建议被单行输入框裁掉
      outer.style.width = `${input.clientWidth}px`;
      outer.style.height = 'auto';
      const needed = Math.max(44, Math.min(outer.scrollHeight, 240));
      outer.style.height = `${needed}px`;
      if (input.style.minHeight !== `${needed}px`) input.style.minHeight = `${needed}px`;
      inner.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    };
    sync();
    input.addEventListener('scroll', sync, { passive: true });
    // 窗口缩放 / 换行导致的高度变化 / 标签页重新可见：都重新对齐宽高
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(input);
    return () => {
      observer?.disconnect();
      input.removeEventListener('scroll', sync);
      input.style.minHeight = '';
    };
  });

  if (!visible) return null;
  return (
    <div
      ref={box}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-0 overflow-hidden px-4 py-3 text-base md:text-sm"
    >
      <div ref={layer} className="whitespace-pre-wrap break-words">
        <span className="text-transparent">{draft}</span>
        <span className="text-muted-foreground/70">{suffix}</span>
        <span className="ml-1 text-[0.8em] text-muted-foreground/60">→</span>
      </div>
    </div>
  );
}
