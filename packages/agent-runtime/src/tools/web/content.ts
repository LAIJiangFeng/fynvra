import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/** HTML 解析前截取的上限（字符） */
export const HTML_PARSE_MAX_CHARS = 2 * 1024 * 1024;
/** JSON 不超过这个字节数时格式化输出 */
export const JSON_PRETTY_MAX_BYTES = 1024 * 1024;
/** Readability 的元素上限：防止超大页面长时间阻塞 worker 进程 */
const MAX_ELEMS_TO_PARSE = 30_000;
/** 提取出的正文短于这个字符数时回退为整页 body */
const MIN_ARTICLE_CHARS = 200;
/** 最终正文短于这个字符数且页面有脚本时，提示可能需要 JS 渲染 */
const JS_HINT_MAX_CHARS = 200;

export interface ConvertedPage {
  title?: string;
  text: string;
  notes: string[];
}

export type ConvertResult = { ok: true; page: ConvertedPage } | { ok: false; error: string };

type Kind = 'html' | 'json' | 'xml' | 'text';

/** 按 Content-Type（缺失时按内容嗅探）把响应正文转成文本；不支持的类型返回错误 */
export function convertBody(body: Buffer, contentType: string, baseUrl: string): ConvertResult {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const kind = classify(mime, body);
  if (!kind) {
    return {
      ok: false,
      error: `unsupported content type ${mime || '(unknown binary)'}: web_fetch only reads HTML and text pages; PDF, images, audio, video and other binary files are not supported`,
    };
  }
  const decoded = decode(body, contentType, kind);
  const notes = decoded.note ? [decoded.note] : [];
  if (kind === 'html') {
    const page = htmlToMarkdown(decoded.text, baseUrl);
    return { ok: true, page: { ...page, notes: [...notes, ...page.notes] } };
  }
  let text = decoded.text;
  if (kind === 'json' && body.length <= JSON_PRETTY_MAX_BYTES) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      notes.push('The JSON could not be parsed; showing it as text.');
    }
  }
  return { ok: true, page: { text, notes } };
}

function classify(mime: string, body: Buffer): Kind | undefined {
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/rss' ||
    mime === 'application/atom'
  ) {
    return 'xml';
  }
  if (mime.startsWith('text/')) return 'text';
  if (mime && mime !== 'application/octet-stream') return undefined;
  // 没有可用的 Content-Type：含 NUL 的视为二进制，像 HTML 的按 HTML，其余按文本
  const head = body.subarray(0, 4096);
  if (head.includes(0)) return undefined;
  const sample = head.toString('latin1').trimStart().slice(0, 512).toLowerCase();
  if (sample.startsWith('<!doctype html') || sample.includes('<html')) return 'html';
  return mime ? undefined : 'text';
}

/** 字符集：Content-Type 的 charset → BOM → 前 4KB 的 meta / XML 声明 → utf-8；标签无效时回退 utf-8 并注明 */
export function decode(
  body: Buffer,
  contentType: string,
  kind: Kind = 'text'
): { text: string; note?: string } {
  const label =
    /charset\s*=\s*["']?\s*([^"';\s]+)/i.exec(contentType)?.[1] ??
    bomCharset(body) ??
    (kind === 'html' || kind === 'xml' ? sniffCharset(body) : undefined) ??
    'utf-8';
  try {
    return { text: new TextDecoder(label).decode(body) };
  } catch {
    return {
      text: new TextDecoder('utf-8').decode(body),
      note: `Unknown character set "${label.slice(0, 40)}"; decoded as UTF-8, some characters may be wrong.`,
    };
  }
}

function bomCharset(body: Buffer): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return undefined;
}

function sniffCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 4096).toString('latin1');
  return (
    /<meta[^>]+charset\s*=\s*["']?\s*([-\w:.]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([-\w:.]+)["']/i.exec(head)?.[1]
  );
}

let turndown: TurndownService | undefined;

function markdownService(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    turndown.remove([
      'script',
      'style',
      'noscript',
      'template',
      'iframe',
      'svg',
      'canvas',
    ] as never);
  }
  return turndown;
}

// linkedom 的 DOM 类型与本包（无 DOM lib）不相干，这里只用到很小的子集
interface MiniElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
interface MiniDocument {
  title: string;
  body: { innerHTML: string } | null;
  querySelectorAll(selector: string): Iterable<MiniElement> & { length: number };
}

function parseDocument(html: string): MiniDocument {
  // linkedom 对没有 <html> 的片段不建 body：补成完整文档
  const source = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return parseHTML(source).document as unknown as MiniDocument;
}

/**
 * HTML → Markdown：截取前 2MB，linkedom 建 DOM，Readability 提取正文，turndown 转 Markdown；
 * 提取失败或正文过短时回退为整页 body；正文极短且页面有脚本时提示可能需要 JS 渲染。
 */
export function htmlToMarkdown(html: string, baseUrl: string): ConvertedPage {
  const notes: string[] = [];
  let source = html;
  if (source.length > HTML_PARSE_MAX_CHARS) {
    source = source.slice(0, HTML_PARSE_MAX_CHARS);
    notes.push('The HTML is larger than 2 MB; only the first 2 MB were parsed.');
  }
  const document = parseDocument(source);
  const title = document.title?.trim() || undefined;
  const hasScripts = document.querySelectorAll('script').length > 0;
  absolutizeLinks(document, baseUrl);

  let markdown = '';
  try {
    const article = new Readability(document as never, {
      maxElemsToParse: MAX_ELEMS_TO_PARSE,
    }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= MIN_ARTICLE_CHARS) {
      markdown = markdownService().turndown(article.content);
    }
  } catch {
    // 元素过多或解析失败：回退为整页 body
  }
  if (!markdown.trim()) {
    // Readability 会改动 DOM：回退时重新解析
    const fallback = parseDocument(source);
    absolutizeLinks(fallback, baseUrl);
    for (const element of fallback.querySelectorAll(
      'script, style, noscript, template, iframe, svg, canvas, nav, footer'
    )) {
      element.remove();
    }
    markdown = fallback.body ? markdownService().turndown(fallback.body.innerHTML) : '';
  }
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
  if (markdown.length < JS_HINT_MAX_CHARS && hasScripts) {
    notes.push(
      'The page returned very little text and uses scripts: it may need JavaScript rendering, so the content is probably incomplete.'
    );
  }
  return { ...(title ? { title } : {}), text: markdown, notes };
}

/** 相对链接和图片地址改成绝对地址；非 http(s) 链接（javascript: 等）去掉 */
function absolutizeLinks(document: MiniDocument, baseUrl: string): void {
  for (const [selector, attribute] of [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
  ] as const) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      try {
        const absolute = new URL(value, baseUrl);
        if (absolute.protocol === 'http:' || absolute.protocol === 'https:') {
          element.setAttribute(attribute, absolute.href);
          continue;
        }
      } catch {
        // 无效地址：去掉
      }
      if (!value.startsWith('#')) element.setAttribute(attribute, '');
    }
  }
}

/** 4xx/5xx 的正文摘录：去掉标签与多余空白 */
export function errorExcerpt(body: Buffer, contentType: string, maxChars: number): string {
  const text = decode(body, contentType, 'html').text;
  const plain = /html|xml/i.test(contentType) || /^\s*</.test(text) ? stripTags(text) : text;
  return plain.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
