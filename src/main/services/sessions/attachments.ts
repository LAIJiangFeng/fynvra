// 超过内联上限的聊天附件副本（ARCHITECTURE §7.12）：Main 把文档抽出的文字存进
// `<userData>/session-attachments/<sessionId>/`，正文只放路径说明，agent 用读文件 / 搜索工具分段读取。
// 副本不进用户工作区、不用用户原始路径；文件名由 Main 生成，agent 对该目录只读（审批门拦写入）。
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ChatFileCopy } from '@shared/types/chat';
import { MAX_CHAT_FILE_BYTES } from '@shared/types/chat';
import { parseSessionId } from './sessionStore';

/** userData 下存放副本的目录名 */
export const SESSION_ATTACHMENTS_DIR = 'session-attachments';
/** 显示名（File.name / 渠道附件名）的长度上限 */
export const MAX_ATTACHMENT_NAME_CHARS = 255;
/** 副本文件名里保留的原名部分的长度上限 */
const MAX_STEM_CHARS = 80;
/** 这些格式存的是抽出的纯文本：副本再加 `.txt`，免得读文件工具按原格式处理 */
const EXTRACTED_EXTS = new Set(['pdf', 'docx', 'xlsx']);
/** 渠道会话（triage / restricted）的副本：修改时间超过 7 天就删 */
export const CHANNEL_COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 渠道会话的副本总大小上限：超出时从最旧的删起 */
export const CHANNEL_COPY_MAX_BYTES = 512 * 1024 * 1024;

export interface PruneOptions {
  maxAgeMs?: number;
  maxBytes?: number;
  now?: number;
}

export interface SessionAttachments {
  /** 会话的副本目录（不保证已存在）；会话 id 不合法时抛错 */
  dirOf(sessionId: string): string;
  /** 写一份副本；content 是 UTF-8 文本字节 */
  save(sessionId: string, name: string, content: Uint8Array): Promise<ChatFileCopy>;
  /** 删掉会话的副本目录（不存在也算成功） */
  remove(sessionId: string): Promise<void>;
  /**
   * 按渠道规则清理会话的副本：删掉过期的，再从最旧的删到总大小不超上限，删空了连目录一起删。
   * 只看目录第一层的普通文件（lstat，不跟随符号链接、不进子目录）。永不抛异常，出错只记 warn。
   */
  prune(sessionId: string, options?: PruneOptions): Promise<void>;
}

/** 显示名：非空、长度有限、不含路径分隔符与控制字符，不是 `.` / `..` */
export function isValidAttachmentName(name: unknown): name is string {
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_ATTACHMENT_NAME_CHARS) {
    return false;
  }
  if (name === '.' || name === '..') return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
  return !/[\\/\u0000-\u001f\u007f]/.test(name);
}

/** 副本文件名：随机前缀 + 只含安全字符的原名（保留扩展名用于显示）；抽取格式再加 `.txt` */
export function copyFileName(name: string, prefix: string): string {
  let safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/\.+$/, '');
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 ? safe.slice(dot + 1).toLowerCase() : '';
  if (safe.length > MAX_STEM_CHARS) {
    // 截断时保住扩展名
    const tail = ext && ext.length <= 10 ? `.${ext}` : '';
    safe = `${safe.slice(0, MAX_STEM_CHARS - tail.length)}${tail}`;
  }
  const base = `${prefix}-${safe || 'attachment'}`;
  return EXTRACTED_EXTS.has(ext) || !ext ? `${base}.txt` : base;
}

/** UTF-8 文本字节的行数：按 `\n` 计，末尾没有换行的最后一段也算一行 */
export function countByteLines(content: Uint8Array): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines++;
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function createSessionAttachments(options: {
  /** 副本根目录（生产为 `<userData>/session-attachments`） */
  root: string;
  newPrefix?: () => string;
}): SessionAttachments {
  const root = resolve(options.root);
  const newPrefix = options.newPrefix ?? (() => randomBytes(4).toString('hex'));

  function dirOf(sessionId: string): string {
    const id = parseSessionId(sessionId);
    if (!id) throw new Error('invalid session id');
    const dir = join(root, id);
    if (!isInside(root, dir)) throw new Error('invalid session id');
    return dir;
  }

  return {
    dirOf,
    async save(sessionId, name, content) {
      if (!isValidAttachmentName(name)) throw new Error('invalid attachment name');
      if (content.length === 0 || content.length > MAX_CHAT_FILE_BYTES) {
        throw new Error('attachment copy is empty or too large');
      }
      const dir = dirOf(sessionId);
      const path = join(dir, copyFileName(name, newPrefix()));
      if (!isInside(dir, path)) throw new Error('invalid attachment name');
      await mkdir(dir, { recursive: true });
      // wx：同名（前缀碰撞）时报错而不是覆盖
      await writeFile(path, content, { flag: 'wx' });
      return { path, bytes: content.length, lines: countByteLines(content) };
    },
    async remove(sessionId) {
      await rm(dirOf(sessionId), { recursive: true, force: true });
    },
    async prune(sessionId, options = {}) {
      const now = options.now ?? Date.now();
      const maxAgeMs = options.maxAgeMs ?? CHANNEL_COPY_MAX_AGE_MS;
      const maxBytes = options.maxBytes ?? CHANNEL_COPY_MAX_BYTES;
      try {
        const dir = dirOf(sessionId);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        const files: { path: string; size: number; mtime: number }[] = [];
        for (const name of names) {
          const path = join(dir, name);
          const info = await lstat(path).catch(() => undefined);
          if (info?.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
        }
        files.sort((a, b) => a.mtime - b.mtime);
        let total = files.reduce((sum, file) => sum + file.size, 0);
        let left = names.length;
        for (const file of files) {
          // 从旧到新：这一份没过期且总量已在上限内，后面更新的也都留下
          if (now - file.mtime <= maxAgeMs && total <= maxBytes) break;
          try {
            await rm(file.path, { force: true });
            total -= file.size;
            left--;
          } catch (error) {
            console.warn('[attachments] 删除附件副本失败', error);
          }
        }
        if (left === 0) await rmdir(dir).catch(() => undefined);
      } catch (error) {
        console.warn('[attachments] 清理附件副本失败', error);
      }
    },
  };
}
