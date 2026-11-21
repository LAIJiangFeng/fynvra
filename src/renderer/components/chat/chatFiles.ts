import {
  type ChatFileRejection,
  decodeText,
  extractChatFileText,
  pdfDocumentText,
  type ReadChatFileResult,
  repackXlsx,
  sheetsToText,
  type XlsxSheet,
} from '@shared/chatFileText';
import { MAX_CHAT_FILE_BYTES } from '@shared/types/chat';

export type { ChatFileRejection, ReadChatFileResult };
export { decodeText, sheetsToText };

async function extractPdfText(data: Uint8Array): Promise<string> {
  const { openPdf } = await import('../files/pdfjs');
  const task = await openPdf(data);
  try {
    return await pdfDocumentText(await task.promise);
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

async function extractXlsxText(data: Uint8Array): Promise<string> {
  const [fflate, { default: readXlsxFile }] = await Promise.all([
    import('fflate'),
    import('read-excel-file/universal'),
  ]);
  // shortcut: 解压和重新打包在渲染主线程同步执行，超大表会让界面短暂卡住；需要时改用 Vite 打包的同源 worker。
  const stored = repackXlsx(data, fflate);
  const sheets = await readXlsxFile(stored.slice().buffer);
  // 库的类型把日期写成了 typeof Date，实际返回 Date 实例
  return sheetsToText(sheets as unknown as XlsxSheet[]);
}

/** 读一个附件并抽出纯文本，规则见 `@shared/chatFileText` 的 extractChatFileText */
export async function readChatFile(file: File): Promise<ReadChatFileResult> {
  if (file.size > MAX_CHAT_FILE_BYTES) return { ok: false, reason: 'size' };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return extractChatFileText(file.name, bytes, {
    pdf: extractPdfText,
    docx: extractDocxText,
    xlsx: extractXlsxText,
  });
}
