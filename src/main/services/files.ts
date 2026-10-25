import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type DirectoryRequest,
  type DirectoryResult,
  type FileError,
  type FilePreview,
  type FileRequest,
  type FileResult,
  type FileWriteRequest,
  type FileWriteResult,
  parseDirectoryRequest,
  parseFileRequest,
  parseWriteRequest,
  type WorkspaceFileEntry,
} from '@shared/types/files';
import type { Workspace } from '@shared/types/workspace';

export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 2000;

interface WorkspaceFiles {
  root: string;
  entries: Map<string, WorkspaceFileEntry>;
  ids: Map<string, string>;
}

class FileAccessError extends Error {
  constructor(readonly code: FileError) {
    super(code);
  }
}

function failure(error: unknown): { ok: false; error: FileError } {
  if (error instanceof FileAccessError) return { ok: false, error: error.code };
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    ok: false,
    error: code === 'ENOENT' || code === 'ENOTDIR' ? 'entryNotFound' : 'unavailable',
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 先校验真实路径，再拒绝链接本身；旧条目的父目录被换成外部链接时同样不可读。 */
async function checkedPath(root: string, rel: string): Promise<string> {
  const path = join(root, rel);
  const target = await realpath(path);
  if (!isWithin(root, target)) throw new FileAccessError('outsideWorkspace');
  if ((await lstat(path)).isSymbolicLink()) throw new FileAccessError('notFile');
  return target;
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function previewOf(bytes: Buffer, size: number): FilePreview {
  const mime = imageMime(bytes);
  if (size > MAX_IMAGE_BYTES || (!mime && size > MAX_TEXT_BYTES))
    return { kind: 'unsupported', reason: 'tooLarge', size };
  if (mime)
    return { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, size };
  try {
    if (bytes.includes(0)) throw new Error('二进制文件');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { kind: 'text', text, size, version: versionOf(bytes) };
  } catch {
    return { kind: 'unsupported', reason: 'binary', size };
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  // Windows 的路径 stat 返回 dev=0，句柄 stat 则返回卷号，不能直接比较。
  return a.ino === b.ino && (process.platform === 'win32' || a.dev === b.dev);
}

async function snapshot(files: WorkspaceFiles, entry: WorkspaceFileEntry) {
  if (entry.kind !== 'file') throw new FileAccessError('notFile');
  const path = await checkedPath(files.root, entry.relativePath);
  if (!(await lstat(path)).isFile()) throw new FileAccessError('notFile');
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new FileAccessError('notFile');
    const checked = await checkedPath(files.root, entry.relativePath);
    if (checked !== path || !sameFile(await lstat(checked, { bigint: true }), info))
      throw new FileAccessError('conflict');
    let bytes = Buffer.alloc(0);
    if (info.size <= BigInt(MAX_IMAGE_BYTES)) {
      // 有界读取，即便文件同时增长也不把无限内容带进 IPC。
      const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    }
    const after = await handle.stat({ bigint: true });
    if (
      info.mtimeNs !== after.mtimeNs ||
      info.ctimeNs !== after.ctimeNs ||
      info.size !== after.size
    )
      throw new FileAccessError('conflict');
    return {
      path,
      info,
      bytes,
      preview: previewOf(bytes, Math.max(Number(info.size), bytes.length)),
    };
  } finally {
    await handle.close();
  }
}

/** 文件权限来自 Main 签发的条目 id，不接受 Renderer 提供的路径。所有访问仅限已登记工作区。 */
export function createFilesService({
  getWorkspace,
}: {
  getWorkspace(id: string): Workspace | undefined;
}) {
  const workspaces = new Map<string, WorkspaceFiles>();
  const writes = new Map<string, Promise<unknown>>();
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

  async function workspace(id: string): Promise<WorkspaceFiles> {
    const registered = getWorkspace(id);
    if (!registered) {
      workspaces.delete(id);
      throw new FileAccessError('workspaceNotFound');
    }
    const root = await realpath(registered.repoPath);
    let cached = workspaces.get(id);
    if (!cached || cached.root !== root) {
      cached = { root, entries: new Map(), ids: new Map() };
      workspaces.set(id, cached);
    }
    return cached;
  }

  function find(files: WorkspaceFiles, id: string): WorkspaceFileEntry {
    const entry = files.entries.get(id);
    if (!entry) throw new FileAccessError('entryNotFound');
    return entry;
  }

  async function save(input: FileWriteRequest): Promise<FileWriteResult> {
    const files = await workspace(input.workspaceId);
    const entry = find(files, input.fileId);
    const current = await snapshot(files, entry);
    if (current.preview.kind !== 'text')
      throw new FileAccessError(
        current.preview.kind === 'unsupported' && current.preview.reason === 'tooLarge'
          ? 'tooLarge'
          : 'notText'
      );
    if (current.preview.version !== input.version) throw new FileAccessError('conflict');
    if (input.text.includes('\0')) throw new FileAccessError('notText');
    const bom = current.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const bytes = Buffer.from(`${bom ? '\ufeff' : ''}${input.text}`, 'utf8');
    if (bytes.length > MAX_TEXT_BYTES) throw new FileAccessError('tooLarge');
    const temporary = join(dirname(current.path), `.fynvra-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, 'wx', Number(current.info.mode) & 0o777);
      created = true;
      try {
        await handle.chmod(Number(current.info.mode) & 0o777);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // 替换前再次核对路径、身份和内容，拒绝保存过程中已被外部更新的文件。
      const latest = await snapshot(await workspace(input.workspaceId), entry);
      if (
        latest.path !== current.path ||
        !sameFile(latest.info, current.info) ||
        latest.preview.kind !== 'text' ||
        latest.preview.version !== input.version
      )
        throw new FileAccessError('conflict');
      await rename(temporary, current.path);
      created = false;
      return {
        ok: true,
        preview: { kind: 'text', text: input.text, version: versionOf(bytes), size: bytes.length },
      };
    } finally {
      if (created) await unlink(temporary).catch(() => undefined);
    }
  }

  return {
    async list(raw: DirectoryRequest): Promise<DirectoryResult> {
      const input = parseDirectoryRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        const files = await workspace(input.workspaceId);
        const parent = input.directoryId ? find(files, input.directoryId) : null;
        if (parent && parent.kind !== 'directory') throw new FileAccessError('notDirectory');
        const path = await checkedPath(files.root, parent?.relativePath ?? '');
        const entries: WorkspaceFileEntry[] = [];
        let truncated = false;
        for await (const entry of await opendir(path)) {
          if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
          if (entries.length === MAX_DIRECTORY_ENTRIES) {
            truncated = true;
            break;
          }
          const relativePath = parent ? `${parent.relativePath}/${entry.name}` : entry.name;
          const id = files.ids.get(relativePath) ?? randomUUID();
          const view: WorkspaceFileEntry = {
            id,
            name: entry.name,
            relativePath,
            kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
          };
          files.ids.set(relativePath, id);
          files.entries.set(id, view);
          entries.push(view);
        }
        entries.sort(
          (a, b) =>
            Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
            collator.compare(a.name, b.name)
        );
        return { ok: true, entries, truncated };
      } catch (error) {
        return failure(error);
      }
    },

    async read(raw: FileRequest): Promise<FileResult> {
      const input = parseFileRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        const files = await workspace(input.workspaceId);
        const entry = find(files, input.fileId);
        return { ok: true, preview: (await snapshot(files, entry)).preview };
      } catch (error) {
        return failure(error);
      }
    },

    async write(raw: FileWriteRequest): Promise<FileWriteResult> {
      const input = parseWriteRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        const files = await workspace(input.workspaceId);
        const path = await checkedPath(files.root, find(files, input.fileId).relativePath);
        // 同一路径即使被两个工作区引用，也使用同一条保存队列。
        const key = process.platform === 'win32' ? path.toLowerCase() : path;
        const previous = writes.get(key) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(() => save(input));
        writes.set(key, pending);
        try {
          return await pending;
        } finally {
          if (writes.get(key) === pending) writes.delete(key);
        }
      } catch (error) {
        return failure(error);
      }
    },
  };
}
