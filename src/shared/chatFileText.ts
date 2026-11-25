// 聊天附件的文本抽取规则（输入框与渠道插件共用，ARCHITECTURE §7.12）：与运行环境无关的部分。
// PDF / docx / xlsx 的具体解析器由调用方注入（Renderer 用浏览器版，Main 用 Node 可用的版本）。
import type { unzipSync, zipSync } from 'fflate';
import {
  type ChatFile,
  type ChatFileCopy,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES_TOTAL_CHARS,
} from './types/chat';

/**
 * 抽出文字的上限（字符）：超过消息内联上限 {@link MAX_CHAT_FILES_TOTAL_CHARS} 的文档不再拒绝，改由 Main 保存副本；
 * 这里只挡异常大的抽取结果（与原始文件大小上限同值），PDF / xlsx 抽取超过它就提前停
 */
export const MAX_CHAT_FILE_TEXT_CHARS = MAX_CHAT_FILE_BYTES;

/**
 * 超过内联上限的文档在正文里的说明块：附件块的内容不放全文，只写文件名、大小、行数与 Main 保存的只读副本路径，
 * 提示 agent 用读文件 / 搜索工具分段查看。仍以 `<file name="…">` 块拼进正文（同样的转义与不可信内容边界），气泡照常显示为文件标签
 */
export function chatFileCopyNote(name: string, copy: ChatFileCopy): ChatFile {
  return {
    name,
    text: [
      `[Attachment too large to include inline (over ${MAX_CHAT_FILES_TOTAL_CHARS.toLocaleString('en-US')} characters of text).]`,
      'Its full text was saved as a read-only UTF-8 copy:',
      `path: ${copy.path}`,
      `size: ${copy.bytes} bytes, ${copy.lines} lines`,
      'Read it in parts with the read tool (offset / limit) or search it with grep; do not load it all at once. The copy is read-only.',
    ].join('\n'),
  };
}

export type ChatFileRejection = 'unsupported' | 'empty' | 'unreadable' | 'size';
export type ReadChatFileResult =
  | { ok: true; file: ChatFile }
  | { ok: false; reason: ChatFileRejection };

/** 抽取器抛出它表示文件太大（如解压后超限），结果记为 size；其他异常记为 unreadable */
export class ChatFileTooLargeError extends Error {}

/** 按格式抽纯文本的解析器 */
export interface ChatFileExtractors {
  pdf(data: Uint8Array): Promise<string>;
  docx(data: Uint8Array): Promise<string>;
  xlsx(data: Uint8Array): Promise<string>;
}

function strictDecode(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function countReplacement(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === '\uFFFD') count++;
  return count;
}

/** 无 BOM 时按零字节分布猜 UTF-16：ASCII 字符的高位字节是 0，集中在奇数位（LE）或偶数位（BE） */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const half = bytes.length / 2;
  if (oddZeros >= half * 0.3 && evenZeros < half * 0.05) return 'utf-16le';
  if (evenZeros >= half * 0.3 && oddZeros < half * 0.05) return 'utf-16be';
  return null;
}

/** 串口日志开头的 FF/FE 乱码会被误当 UTF-16 BOM：去掉这些字节后是不含 NUL 的严格 UTF-8，就不认 BOM */
function isUtf8AfterGarbage(bytes: Uint8Array): boolean {
  let i = 0;
  while (bytes[i] === 0xff || bytes[i] === 0xfe) i++;
  const text = strictDecode('utf-8', bytes.subarray(i));
  return !!text && !text.includes('\0');
}

// 可疑字符：U+FFFD、NUL，以及除 \t \n \v \f \r 和 ESC（ANSI 颜色）以外的 C0 控制字符和 DEL
function isSuspicious(code: number): boolean {
  if (code === 0xfffd || code === 0x7f) return true;
  return code < 0x20 && !(code >= 0x09 && code <= 0x0d) && code !== 0x1b;
}

/**
 * 把附件字节解码成文本：BOM → UTF-16 探测 → 严格 UTF-8 → 严格 GB18030 → 有损择优；
 * 可疑字符超过 10% 视为二进制返回 null；通过后去掉 NUL（串口日志上电时常混入）。
 */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string | null = null;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    text = new TextDecoder('utf-8').decode(bytes.subarray(3));
  } else if (startsWith(bytes, [0xff, 0xfe]) && !isUtf8AfterGarbage(bytes)) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  } else if (startsWith(bytes, [0xfe, 0xff]) && !isUtf8AfterGarbage(bytes)) {
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } else {
    const utf16 = sniffUtf16(bytes);
    if (utf16) text = new TextDecoder(utf16).decode(bytes);
  }
  text ??= strictDecode('utf-8', bytes) ?? strictDecode('gb18030', bytes);
  if (text === null) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const gb = new TextDecoder('gb18030').decode(bytes);
    // GB18030 明显更好才选它，避免夹着乱码字节的 UTF-8 日志被误判成 GBK
    text = countReplacement(gb) * 4 < countReplacement(utf8) ? gb : utf8;
  }
  let suspicious = 0;
  for (let i = 0; i < text.length; i++) if (isSuspicious(text.charCodeAt(i))) suspicious++;
  if (suspicious > text.length * 0.1) return null;
  return text.replaceAll('\0', '');
}

export function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

export const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

export type XlsxCell = string | number | boolean | Date | null;
export interface XlsxSheet {
  sheet: string;
  data: XlsxCell[][];
}

function cellToText(cell: XlsxCell): string {
  if (cell === null) return '';
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return '';
    const iso = cell.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof cell === 'string') return cell.replace(/[\t\r\n]/g, ' ');
  return String(cell);
}

/** 工作表转文本：每表一段 `## Sheet: 名称` + TSV 行，表间空一行；跳过空行与空表；超过字数上限提前停 */
export function sheetsToText(sheets: readonly XlsxSheet[]): string {
  const blocks: string[] = [];
  let total = 0;
  for (const { sheet, data } of sheets) {
    const lines: string[] = [];
    for (const row of data) {
      const cells = row.map(cellToText);
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) continue;
      const line = cells.join('\t');
      lines.push(line);
      total += line.length + 1;
      if (total > MAX_CHAT_FILE_TEXT_CHARS) break;
    }
    if (lines.length > 0) blocks.push(`## Sheet: ${sheet}\n${lines.join('\n')}`);
    if (total > MAX_CHAT_FILE_TEXT_CHARS) break;
  }
  return blocks.join('\n\n');
}

/** xlsx 解压后 XML 部件的总大小上限，防压缩炸弹撑爆内存 */
const MAX_XLSX_UNPACKED_BYTES = 64 * 1024 * 1024;

/**
 * 同步解压 xlsx 的 XML 部件，再按 stored（不压缩）重新打包交给 read-excel-file。
 * fflate 异步 unzip() 遇到解压后 ≥512KB 的 deflate 条目会起 blob worker，渲染进程里被 CSP 拦下且 Promise 一直挂起，
 * stored 条目则被同步 slice。fflate 的两个函数由调用方传入（Main 只能用 fflate/browser）。
 */
export function repackXlsx(
  data: Uint8Array,
  fflate: { unzipSync: typeof unzipSync; zipSync: typeof zipSync }
): Uint8Array {
  let unpacked = 0;
  const entries = fflate.unzipSync(data, {
    filter: (file) => {
      if (!file.name.endsWith('.xml') && !file.name.endsWith('.rels')) return false;
      unpacked += file.originalSize;
      if (unpacked > MAX_XLSX_UNPACKED_BYTES) throw new ChatFileTooLargeError();
      return true;
    },
  });
  return fflate.zipSync(entries, { level: 0 });
}

/** pdf.js 文档的最小结构（Renderer 与 Main 用的 pdf.js 构建不同，只按形状对接） */
export interface PdfTextDocument {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: readonly object[] }>;
    cleanup(): unknown;
  }>;
}

/** PDF 逐页抽文字：hasEOL 换行，页之间空一行；超过字数上限就提前停 */
export async function pdfDocumentText(doc: PdfTextDocument): Promise<string> {
  const pages: string[] = [];
  let total = 0;
  for (let n = 1; n <= doc.numPages && total <= MAX_CHAT_FILE_TEXT_CHARS; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item) || typeof item.str !== 'string') continue;
      text += item.str;
      if ('hasEOL' in item && item.hasEOL) text += '\n';
    }
    page.cleanup();
    pages.push(text);
    total += text.length + 2;
  }
  return pages.join('\n\n');
}

async function extract(
  run: () => Promise<string>
): Promise<string | { reason: ChatFileRejection }> {
  try {
    return await run();
  } catch (error) {
    return { reason: error instanceof ChatFileTooLargeError ? 'size' : 'unreadable' };
  }
}

/**
 * 按扩展名与魔数分派，抽出附件的纯文本：PDF、Word .docx、Excel .xlsx、文本（UTF-8 / UTF-16 / GBK）；
 * 其他格式（旧版 .doc / .xls、二进制等）不支持。`name` 只用于取扩展名和作为结果的文件名。
 * 文字超过内联上限不在这里拒绝（由调用方改存副本），只有超过 {@link MAX_CHAT_FILE_TEXT_CHARS} 才记为 size。
 */
export async function extractChatFileText(
  name: string,
  bytes: Uint8Array,
  extractors: ChatFileExtractors
): Promise<ReadChatFileResult> {
  if (bytes.length > MAX_CHAT_FILE_BYTES) return { ok: false, reason: 'size' };
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  let text: string | { reason: ChatFileRejection } | null;
  if (ext === 'pdf' && startsWith(bytes, PDF_MAGIC)) {
    text = await extract(() => extractors.pdf(bytes));
  } else if (ext === 'docx' && startsWith(bytes, ZIP_MAGIC)) {
    text = await extract(() => extractors.docx(bytes));
  } else if (ext === 'xlsx' && startsWith(bytes, ZIP_MAGIC)) {
    text = await extract(() => extractors.xlsx(bytes));
  } else {
    text = decodeText(bytes);
    if (text === null) return { ok: false, reason: 'unsupported' };
  }
  if (typeof text !== 'string') return { ok: false, reason: text.reason };
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CHAT_FILE_TEXT_CHARS) return { ok: false, reason: 'size' };
  return { ok: true, file: { name, text } };
}
