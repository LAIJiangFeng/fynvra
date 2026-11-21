import { type ChatFile, MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES_TOTAL_CHARS } from '@shared/types/chat';

export type ChatFileRejection = 'unsupported' | 'empty' | 'unreadable' | 'size';
export type ReadChatFileResult =
  | { ok: true; file: ChatFile }
  | { ok: false; reason: ChatFileRejection };

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

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

/** PDF 逐页抽文字：hasEOL 换行，页之间空一行；超过字数上限就提前停 */
async function extractPdfText(data: Uint8Array): Promise<string> {
  const { openPdf } = await import('../files/pdfjs');
  const task = await openPdf(data);
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages && total <= MAX_CHAT_FILES_TOTAL_CHARS; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      page.cleanup();
      pages.push(text);
      total += text.length + 2;
    }
    return pages.join('\n\n');
  } finally {
    // 销毁 loading task 会连同文档与 worker 一起释放
    void task.destroy();
  }
}

async function extractDocxText(data: Uint8Array): Promise<string> {
  const { default: mammoth } = await import('mammoth');
  // 复制到独立 ArrayBuffer，避免 byteOffset 视图把多余字节交给解析器
  const { value } = await mammoth.extractRawText({ arrayBuffer: data.slice().buffer });
  return value;
}

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
      if (total > MAX_CHAT_FILES_TOTAL_CHARS) break;
    }
    if (lines.length > 0) blocks.push(`## Sheet: ${sheet}\n${lines.join('\n')}`);
    if (total > MAX_CHAT_FILES_TOTAL_CHARS) break;
  }
  return blocks.join('\n\n');
}

/** xlsx 解压后 XML 部件的总大小上限，防压缩炸弹撑爆渲染进程内存 */
const MAX_XLSX_UNPACKED_BYTES = 64 * 1024 * 1024;

class XlsxTooLargeError extends Error {}

async function extractXlsxText(data: Uint8Array): Promise<string> {
  const [{ unzipSync, zipSync }, { default: readXlsxFile }] = await Promise.all([
    import('fflate'),
    import('read-excel-file/universal'),
  ]);
  // fflate 异步 unzip() 遇到解压后 ≥512KB 的 deflate 条目会起 blob worker，被 CSP `script-src 'self'` 拦下，
  // 而它不监听 error，Promise 会一直挂起；stored（不压缩）条目则被同步 slice。所以先同步解压，再按 stored 重新打包。
  // shortcut: 解压和重新打包在渲染主线程同步执行，超大表会让界面短暂卡住；需要时改用 Vite 打包的同源 worker。
  let unpacked = 0;
  const entries = unzipSync(data, {
    filter: (file) => {
      if (!file.name.endsWith('.xml') && !file.name.endsWith('.rels')) return false;
      unpacked += file.originalSize;
      if (unpacked > MAX_XLSX_UNPACKED_BYTES) throw new XlsxTooLargeError();
      return true;
    },
  });
  const stored = zipSync(entries, { level: 0 });
  const sheets = await readXlsxFile(stored.slice().buffer);
  // 库的类型把日期写成了 typeof Date，实际返回 Date 实例
  return sheetsToText(sheets as unknown as XlsxSheet[]);
}

/** 读一个附件并抽出纯文本：PDF、Word .docx、Excel .xlsx、文本（UTF-8 / UTF-16 / GBK）；其他格式（旧版 .doc / .xls、二进制等）不支持 */
export async function readChatFile(file: File): Promise<ReadChatFileResult> {
  if (file.size > MAX_CHAT_FILE_BYTES) return { ok: false, reason: 'size' };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  let text: string | null;
  if (ext === 'pdf' && startsWith(bytes, PDF_MAGIC)) {
    try {
      text = await extractPdfText(bytes);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  } else if (ext === 'docx' && startsWith(bytes, ZIP_MAGIC)) {
    try {
      text = await extractDocxText(bytes);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  } else if (ext === 'xlsx' && startsWith(bytes, ZIP_MAGIC)) {
    try {
      text = await extractXlsxText(bytes);
    } catch (error) {
      return { ok: false, reason: error instanceof XlsxTooLargeError ? 'size' : 'unreadable' };
    }
  } else {
    text = decodeText(bytes);
    if (text === null) return { ok: false, reason: 'unsupported' };
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CHAT_FILES_TOTAL_CHARS) return { ok: false, reason: 'size' };
  return { ok: true, file: { name: file.name, text } };
}
