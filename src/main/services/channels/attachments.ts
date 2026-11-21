// 渠道插件附件（ARCHITECTURE §7.12「渠道 API」channel.prompt）：从插件私有数据目录的 attachments/ 读文件，
// 按聊天输入框同一套规则分成图片与文档（文档抽出纯文本），超限或不支持的记为 rejected。
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ChatFileExtractors,
  type ChatFileRejection,
  extractChatFileText,
  pdfDocumentText,
  repackXlsx,
  sheetsToText,
  startsWith,
  type XlsxSheet,
} from '@shared/chatFileText';
import type { ChannelAttachment, ChannelAttachmentRejection } from '@shared/types/appPluginApi';
import {
  type ChatFile,
  type ChatImage,
  type ChatImageMimeType,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  MAX_CHAT_FILES_TOTAL_CHARS,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from '@shared/types/chat';

export interface LoadedAttachments {
  files: ChatFile[];
  images: ChatImage[];
  rejected: ChannelAttachmentRejection[];
}

async function extractPdfText(data: Uint8Array): Promise<string> {
  // 用 .min 构建：未压缩的 pdf.mjs 里有局部 `const require`，打进 Main 产物后会触发 require 声明检查（见 fflateImport.test.ts）
  // 先加载 worker 模块：它会设置 globalThis.pdfjsWorker，pdf.js 随后在本进程内（fake worker）解析，不起线程也不按路径 import
  await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  // shortcut: 未提供 cMap 与标准字体资源，缺 ToUnicode 的 CJK 字体可能抽不出字；需要时把 cmaps 作为资源打进包再传 cMapUrl
  const params = {
    data: data.slice(),
    // 只抽文字不渲染：不装字体、不读系统字体、不用 wasm
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    // pdf.js 6 已移除基于 eval 的编译（该选项不再读取），仍显式关闭以示意图
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0,
  };
  const task = getDocument(params);
  try {
    return await pdfDocumentText(await task.promise);
  } finally {
    void task.destroy();
  }
}

async function extractDocxText(data: Uint8Array): Promise<string> {
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return value;
}

async function extractXlsxText(data: Uint8Array): Promise<string> {
  // Main 只能用 fflate/browser：node 版的 `var require` 会与 electron-vite 的 require shim 重名
  const [fflate, { default: readXlsxFile }] = await Promise.all([
    import('fflate/browser'),
    import('read-excel-file/universal'),
  ]);
  const sheets = await readXlsxFile(repackXlsx(data, fflate).slice().buffer);
  return sheetsToText(sheets as unknown as XlsxSheet[]);
}

export const MAIN_EXTRACTORS: ChatFileExtractors = {
  pdf: extractPdfText,
  docx: extractDocxText,
  xlsx: extractXlsxText,
};

/** 按魔数识别图片格式，不看扩展名 */
export function sniffImage(bytes: Uint8Array): ChatImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? 'image/gif' : null;
  }
  const riff = startsWith(bytes, [0x52, 0x49, 0x46, 0x46]);
  if (riff && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/**
 * 读 `<realDataDir>/attachments/<file>`：只认目录内的普通文件（符号链接、目录、越界一律 unreadable）。
 * 打开后再比对 inode，防止检查与读取之间被换成链接。
 */
async function readAttachment(dir: string, file: string): Promise<Uint8Array | ChatFileRejection> {
  const path = join(dir, file);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return 'unreadable';
    if (dirname(await realpath(path)) !== dir) return 'unreadable';
    if (info.size > MAX_CHAT_FILE_BYTES) return 'size';
    const handle = await open(path, 'r');
    try {
      const opened = await handle.stat();
      // 只比 ino：Windows 上 lstat 与 fstat 给出的 dev 不一致
      if (!opened.isFile() || opened.ino !== info.ino) return 'unreadable';
      if (opened.size > MAX_CHAT_FILE_BYTES) return 'size';
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return 'unreadable';
  }
}

/** 逐个读取并分类附件（file 与 name 已在 API 入口校验清洗）；上限全部沿用输入框（MAX_CHAT_*），超出的那个及之后同类的记为 size */
export async function loadAttachments(
  dataDir: string,
  attachments: readonly ChannelAttachment[],
  extractors: ChatFileExtractors = MAIN_EXTRACTORS
): Promise<LoadedAttachments> {
  const loaded: LoadedAttachments = { files: [], images: [], rejected: [] };
  if (attachments.length === 0) return loaded;
  let dir: string | null;
  try {
    dir = join(await realpath(dataDir), 'attachments');
  } catch {
    dir = null;
  }
  let imageBytes = 0;
  let chars = 0;
  for (const { file, name } of attachments) {
    const reject = (reason: ChatFileRejection) => loaded.rejected.push({ name, reason });
    const bytes = dir ? await readAttachment(dir, file) : 'unreadable';
    if (typeof bytes === 'string') {
      reject(bytes);
      continue;
    }
    const mimeType = sniffImage(bytes);
    if (mimeType) {
      if (
        loaded.images.length >= MAX_CHAT_IMAGES ||
        bytes.length > MAX_CHAT_IMAGE_BYTES ||
        imageBytes + bytes.length > MAX_CHAT_IMAGES_TOTAL_BYTES
      ) {
        reject('size');
        continue;
      }
      imageBytes += bytes.length;
      loaded.images.push({ data: Buffer.from(bytes).toString('base64'), mimeType });
      continue;
    }
    if (loaded.files.length >= MAX_CHAT_FILES) {
      reject('size');
      continue;
    }
    const result = await extractChatFileText(name, bytes, extractors);
    if (!result.ok) {
      reject(result.reason);
      continue;
    }
    if (chars + result.file.text.length > MAX_CHAT_FILES_TOTAL_CHARS) {
      reject('size');
      continue;
    }
    chars += result.file.text.length;
    loaded.files.push(result.file);
  }
  return loaded;
}
