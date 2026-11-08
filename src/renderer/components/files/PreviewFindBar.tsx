import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import {
  clearFindHighlights,
  findRanges,
  scrollRangeIntoView,
  setFindHighlights,
} from '@/lib/previewFind';
import { cn } from '@/lib/utils';

const SEARCH_DELAY = 150;

export interface PreviewFindBarProps {
  /** 可滚动的预览容器；查找在其中进行，关闭后焦点还给它（建议设 tabIndex={-1}） */
  containerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  /** 已打开时再次请求聚焦（如重复按 Ctrl+F），变化即重新聚焦并全选 */
  focusSignal?: number;
  className?: string;
}

/**
 * 预览区查找条。渲染在预览滚动容器之外、相对定位的父元素内（absolute 右上角），
 * 用 CSS Custom Highlight API 高亮，不改动预览 DOM。
 */
export function PreviewFindBar({
  containerRef,
  open,
  onClose,
  focusSignal,
  className,
}: PreviewFindBarProps) {
  const t = useT();
  const [owner] = useState(() => Symbol('preview-find'));
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const [compositionTick, setCompositionTick] = useState(0);
  // 已执行查找的关键词；与 query 不同说明防抖中尚未搜索
  const searchedRef = useRef<string | null>(null);

  const scrollTo = useCallback(
    (range: Range | undefined) => {
      const container = containerRef.current;
      if (range && container) scrollRangeIntoView(container, range);
    },
    [containerRef]
  );

  /** 执行查找；reset 时回到第一项并滚动，否则（内容变化）钳住当前序号且不滚动 */
  const runSearch = useEffectEvent((reset: boolean) => {
    const container = containerRef.current;
    searchedRef.current = query;
    const next = container ? findRanges(container, query) : [];
    setMatches(next);
    if (reset) {
      setIndex(0);
      scrollTo(next[0]);
    } else {
      setIndex((current) => Math.max(0, Math.min(current, next.length - 1)));
    }
  });

  // 打开时立即用已有关键词查找；关闭时清空匹配，下次打开重新查
  useEffect(() => {
    if (open) {
      runSearch(true);
      return;
    }
    searchedRef.current = null;
    setMatches([]);
    setIndex(0);
  }, [open]);

  // 输入后防抖查找；输入法组合期间不查找，compositionend 后由 compositionTick 重新触发
  // biome-ignore lint/correctness/useExhaustiveDependencies: compositionTick 仅作为重新触发器
  useEffect(() => {
    if (!open || composingRef.current || searchedRef.current === query) return;
    const timer = window.setTimeout(() => {
      if (searchedRef.current !== query) runSearch(true);
    }, SEARCH_DELAY);
    return () => window.clearTimeout(timer);
  }, [open, query, compositionTick]);

  // 打开或再次请求时聚焦输入框并全选
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSignal 仅作为重新聚焦的触发器
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [open, focusSignal]);

  // 预览内容变化（如双栏编辑）时防抖后重新匹配
  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) return;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!composingRef.current) runSearch(false);
      }, SEARCH_DELAY);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open, containerRef]);

  // 同步高亮；关闭、卸载时清除
  useEffect(() => {
    if (!open) return;
    setFindHighlights(owner, matches, matches[index] ?? null);
    return () => clearFindHighlights(owner);
  }, [open, matches, index, owner]);

  const total = matches.length;
  const step = (delta: number) => {
    if (searchedRef.current !== query) {
      runSearch(true);
      return;
    }
    if (total === 0) return;
    const next = (index + delta + total) % total;
    setIndex(next);
    scrollTo(matches[next]);
  };

  const close = () => {
    clearFindHighlights(owner);
    containerRef.current?.focus({ preventScroll: true });
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  if (!open) return null;

  return (
    <search
      data-preview-find-ignore=""
      aria-label={t('files.find.label')}
      className={cn(
        'absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border bg-popover p-1 text-popover-foreground text-xs shadow-md',
        className
      )}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t('files.find.placeholder')}
        aria-label={t('files.find.placeholder')}
        className="h-6 w-44 rounded-sm bg-transparent px-1.5 outline-none placeholder:text-muted-foreground"
        onChange={(event) => setQuery(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          // compositionend 可能晚于最后一次 change，以最终文字重新触发查找
          setQuery(event.currentTarget.value);
          setCompositionTick((tick) => tick + 1);
        }}
      />
      <span
        role="status"
        className="min-w-12 shrink-0 text-center text-muted-foreground tabular-nums"
      >
        {query
          ? total === 0
            ? t('files.find.noResults')
            : t('files.find.count', { current: index + 1, total })
          : ''}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('files.find.previous')}
        title={t('files.find.previous')}
        disabled={total === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('files.find.next')}
        title={t('files.find.next')}
        disabled={total === 0}
        onClick={() => step(1)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('files.find.close')}
        title={t('files.find.close')}
        onClick={close}
      >
        <X className="size-3.5" />
      </Button>
    </search>
  );
}
