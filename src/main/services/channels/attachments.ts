// 渠道插件附件（ARCHITECTURE §7.12「渠道 API」channel.prompt）：从插件私有数据目录的 attachments/ 读文件，
// 按聊天输入框同一套规则分成图片与文档（文档抽出纯文本），超限或不支持的记为 rejected。
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ChatFileExtractors,
  type ChatFileRejection,
  chatFileCopyNote,
  extractChatFileText,
  startsWith,
} from '@shared/chatFileText';
import { errorMessage } from '@shared/guards';
import type { ChannelAttachment, ChannelAttachmentRejection } from '@shared/types/appPluginApi';
import {
  type ChatFile,
  type ChatFileCopy,
  type ChatImage,
  type ChatImageMimeType,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  MAX_CHAT_FILES_TOTAL_CHARS,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from '@shared/types/chat';
import { type ExtractChatFile, isolatedExtractor } from './docIsolation';

/** 一次 channel.prompt 处理附件的总预算：须明显短于插件 RPC 的 30 秒超时，免得插件误判失败重试造成重复投递 */
export const ATTACHMENTS_BUDGET_MS = 20_000;

/** 把文档文字（UTF-8 字节）存成会话的只读副本（生产为 SessionAttachments.save） */
export type SaveAttachmentCopy = (name: string, content: Uint8Array) => Promise<ChatFileCopy>;

export interface LoadedAttachments {
  files: ChatFile[];
  images: ChatImage[];
  rejected: ChannelAttachmentRejection[];
}

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

/**
 * 逐个读取并分类附件（file 与 name 已在 API 入口校验清洗）；上限全部沿用输入框（MAX_CHAT_*），超出的那个及之后同类的记为 size。
 * 文档文字合计超过内联上限时，有 saveCopy 就把那个文档存成副本、只放路径说明；没有或保存失败才记为 size。
 * 文档默认在隔离 worker 里解析；总预算 budgetMs 用完后，剩下的附件不再处理，记为 unreadable。
 * extractors 可传进程内抽取器（测试用），或按截止时间构造抽取器的函数。
 */
export async function loadAttachments(
  dataDir: string,
  attachments: readonly ChannelAttachment[],
  extractors: ChatFileExtractors | ((deadline: number) => ExtractChatFile) = isolatedExtractor,
  budgetMs = ATTACHMENTS_BUDGET_MS,
  saveCopy?: SaveAttachmentCopy
): Promise<LoadedAttachments> {
  const loaded: LoadedAttachments = { files: [], images: [], rejected: [] };
  if (attachments.length === 0) return loaded;
  const deadline = Date.now() + budgetMs;
  const extract: ExtractChatFile =
    typeof extractors === 'function'
      ? extractors(deadline)
      : (fileName, bytes) => extractChatFileText(fileName, bytes, extractors);
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
    if (Date.now() >= deadline) {
      reject('unreadable');
      continue;
    }
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
    const result = await extract(name, bytes);
    if (!result.ok) {
      reject(result.reason);
      continue;
    }
    if (chars + result.file.text.length > MAX_CHAT_FILES_TOTAL_CHARS) {
      // 路径说明只有几百字：不计入内联合计
      const note = saveCopy ? await copyNote(saveCopy, name, result.file.text) : null;
      if (!note) {
        reject('size');
        continue;
      }
      loaded.files.push(note);
      continue;
    }
    chars += result.file.text.length;
    loaded.files.push(result.file);
  }
  return loaded;
}

/** 存副本并生成路径说明块；UTF-8 超过 32 MiB 或保存失败返回 null */
async function copyNote(
  saveCopy: SaveAttachmentCopy,
  name: string,
  text: string
): Promise<ChatFile | null> {
  const content = new TextEncoder().encode(text);
  if (content.length > MAX_CHAT_FILE_BYTES) return null;
  try {
    return chatFileCopyNote(name, await saveCopy(name, content));
  } catch (error) {
    console.warn(`[channels] 保存附件副本失败：${errorMessage(error)}`);
    return null;
  }
}
