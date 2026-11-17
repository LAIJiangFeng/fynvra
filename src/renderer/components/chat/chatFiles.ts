import {
  type ChatFile,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES_TOTAL_CHARS,
} from '../../../shared/types/chat';

export type ChatFileRejection = 'unsupported' | 'empty' | 'unreadable' | 'size';
export type ReadChatFileResult =
  | { ok: true; file: ChatFile }
  | { ok: false; reason: ChatFileRejection };

/** 按 UTF-8 严格解码并去掉 BOM；不是合法 UTF-8 或含 NUL（多半是二进制）时返回 null */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    // ignoreBOM: false 是默认值，解码器会自己去掉开头的 BOM
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
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

/** 读一个附件并抽出纯文本：PDF、Word .docx、UTF-8 文本；其他格式（旧版 .doc、xlsx、二进制等）不支持 */
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
  } else {
    text = decodeUtf8Text(bytes);
    if (text === null) return { ok: false, reason: 'unsupported' };
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CHAT_FILES_TOTAL_CHARS) return { ok: false, reason: 'size' };
  return { ok: true, file: { name: file.name, text } };
}
