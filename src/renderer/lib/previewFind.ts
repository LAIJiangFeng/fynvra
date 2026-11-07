/**
 * 预览区查找：收集容器内可见文本，按不区分大小写的纯文本匹配映射回 DOM Range。
 * 只读 DOM，不修改 React 管理的节点；匹配可跨越多个文本节点（如代码高亮拆出的 span）。
 */

/** 单次查找的最大匹配数，避免超长文档里生成过多 Range */
export const MAX_FIND_MATCHES = 5000;

/** 带此属性的元素（如查找条本身）不参与匹配 */
export const FIND_IGNORE_ATTR = 'data-preview-find-ignore';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

interface TextSegment {
  node: Text;
  start: number;
}

function isElementVisible(element: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let visible: boolean;
  if (SKIP_TAGS.has(element.tagName) || element.closest(`[${FIND_IGNORE_ATTR}]`)) {
    visible = false;
  } else if (typeof element.checkVisibility === 'function') {
    // 覆盖祖先 display:none、content-visibility 等情况
    visible = element.checkVisibility();
  } else {
    visible = element.getClientRects().length > 0;
  }
  cache.set(element, visible);
  return visible;
}

/** 收集容器内可见文本节点，返回拼接后的整段文本与各节点在其中的起始偏移 */
export function collectText(container: HTMLElement): { text: string; segments: TextSegment[] } {
  const cache = new Map<Element, boolean>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || !isElementVisible(parent, cache)) return NodeFilter.FILTER_REJECT;
      // 有布局盒的元素里仍可能有空白被折叠的文本节点，它们不影响匹配，保留即可
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: TextSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const value = text.nodeValue ?? '';
    segments.push({ node: text, start: offset });
    parts.push(value);
    offset += value.length;
  }
  return { text: parts.join(''), segments };
}

/** 小写化且保持长度不变（少数字符小写后长度会变，此时保留原字符），保证偏移一一对应 */
function lowerSameLength(value: string): string {
  const lowered = value.toLocaleLowerCase();
  if (lowered.length === value.length) return lowered;
  let result = '';
  for (const ch of value) {
    const lower = ch.toLocaleLowerCase();
    result += lower.length === ch.length ? lower : ch;
  }
  return result;
}

/** 在容器内查找 query（不区分大小写，纯文本匹配），返回按文档顺序排列的 Range */
export function findRanges(container: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const { text, segments } = collectText(container);
  if (!text || segments.length === 0) return [];
  const haystack = lowerSameLength(text);
  const needle = lowerSameLength(query);
  const ranges: Range[] = [];
  let segIndex = 0;
  let from = 0;
  while (ranges.length < MAX_FIND_MATCHES) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    from = end;
    // 匹配按顺序出现，节点指针只前进
    while (segIndex < segments.length - 1 && segEnd(segments, segIndex) <= start) segIndex++;
    let endIndex = segIndex;
    while (endIndex < segments.length - 1 && segEnd(segments, endIndex) < end) endIndex++;
    const startSeg = segments[segIndex];
    const endSeg = segments[endIndex];
    if (!startSeg || !endSeg) break;
    const range = document.createRange();
    range.setStart(startSeg.node, start - startSeg.start);
    range.setEnd(endSeg.node, end - endSeg.start);
    ranges.push(range);
  }
  return ranges;
}

function segEnd(segments: TextSegment[], index: number): number {
  const segment = segments[index];
  return segment ? segment.start + (segment.node.nodeValue?.length ?? 0) : 0;
}

/** 把 Range 滚到滚动容器的垂直中部；拿不到几何信息时退回父元素 scrollIntoView */
export function scrollRangeIntoView(container: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const parent = range.startContainer.parentElement;
    parent?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return;
  }
  const box = container.getBoundingClientRect();
  const delta = rect.top + rect.height / 2 - (box.top + container.clientHeight / 2);
  container.scrollTop += delta;
}

/** 当前环境是否支持 CSS Custom Highlight API */
export function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

export const FIND_HIGHLIGHT = 'fynvra-find';
export const FIND_HIGHLIGHT_CURRENT = 'fynvra-find-current';

// Highlight 注册名是全局的：同一时刻只允许一个查找会话持有
let highlightOwner: symbol | null = null;

/** 以 owner 身份设置全部匹配与当前项高亮；不支持时静默跳过 */
export function setFindHighlights(owner: symbol, ranges: Range[], current: Range | null): void {
  if (!supportsHighlights()) return;
  highlightOwner = owner;
  CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges));
  if (current) {
    const highlight = new Highlight(current);
    highlight.priority = 1; // 当前项盖在普通匹配之上
    CSS.highlights.set(FIND_HIGHLIGHT_CURRENT, highlight);
  } else CSS.highlights.delete(FIND_HIGHLIGHT_CURRENT);
}

/** 清除高亮；仅当 owner 仍持有时清除，避免误清其他会话 */
export function clearFindHighlights(owner: symbol): void {
  if (highlightOwner !== owner) return;
  highlightOwner = null;
  if (!supportsHighlights()) return;
  CSS.highlights.delete(FIND_HIGHLIGHT);
  CSS.highlights.delete(FIND_HIGHLIGHT_CURRENT);
}
