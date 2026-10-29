import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type CreateEntryRequest,
  type DirectoryRequest,
  type DirectoryResult,
  type EntryRefRequest,
  type EntryResult,
  type FileError,
  type FilePreview,
  type FileRequest,
  type FileResult,
  type FileWriteRequest,
  type FileWriteResult,
  type MutationResult,
  parseCreateEntryRequest,
  parseDirectoryRequest,
  parseEntryRefRequest,
  parseFileRequest,
  parseRenameEntryRequest,
  parseWriteRequest,
  type RenameEntryRequest,
  type ResolveResult,
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
export interface FilesShell {
  /** 在系统资源管理器中选中显示。 */
  reveal(path: string): void;
  /** 把文件写进系统剪贴板（Windows 为文件本体，其他平台由实现退回路径文本）。 */
  copyFiles(paths: string[]): void;
  /** 移到系统回收站；不直接抹除。 */
  trash(path: string): Promise<void>;
  /** 仅供 openHtml 在真实路径、文件类型及扩展名校验后调用。 */
  openExternal(url: string): Promise<void>;
}

const noopShell: FilesShell = {
  reveal: () => undefined,
  copyFiles: () => undefined,
  trash: async () => undefined,
  openExternal: async () => {
    throw new FileAccessError('unavailable');
  },
};

export function createFilesService({
  getWorkspace,
  shell = noopShell,
}: {
  getWorkspace(id: string): Workspace | undefined;
  shell?: FilesShell;
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

  // ---------------------------------------------------------------------
  // 条目变更（右键菜单）：新建 / 重命名 / 副本 / 删除 / 显示 / 复制 / 解析路径

  const NAME_MAX_CHARS = 120;

  function normalizedName(raw: string): string | null {
    const name = raw.trim();
    const control = Array.from(name).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    );
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      name.length > NAME_MAX_CHARS ||
      name.includes('/') ||
      name.includes('\\') ||
      control
    )
      return null;
    return name;
  }

  /** 条目所在目录（根目录时 relativePath 为空串）：目录本身经 realpath 校验，拒绝符号链接目录。 */
  async function parentOf(
    files: WorkspaceFiles,
    parentDirectoryId?: string
  ): Promise<{ path: string; relativePath: string }> {
    const parent = parentDirectoryId ? find(files, parentDirectoryId) : null;
    if (parent && parent.kind !== 'directory') throw new FileAccessError('notDirectory');
    const relativePath = parent?.relativePath ?? '';
    return { path: await checkedPath(files.root, relativePath), relativePath };
  }

  function register(
    files: WorkspaceFiles,
    relativePath: string,
    kind: WorkspaceFileEntry['kind']
  ): WorkspaceFileEntry {
    const id = files.ids.get(relativePath) ?? randomUUID();
    const entry = { id, name: basename(relativePath), relativePath, kind };
    files.ids.set(relativePath, id);
    files.entries.set(id, entry);
    return entry;
  }

  /** 重命名 / 删除后的缓存改写：条目本身与所有子条目（id 不变），newRel 为 null 时只清除。 */
  function rewritePrefix(files: WorkspaceFiles, oldRel: string, newRel: string | null): void {
    for (const [id, entry] of [...files.entries]) {
      if (entry.relativePath !== oldRel && !entry.relativePath.startsWith(`${oldRel}/`)) continue;
      files.entries.delete(id);
      files.ids.delete(entry.relativePath);
      if (newRel !== null) {
        const next = `${newRel}${entry.relativePath.slice(oldRel.length)}`;
        files.ids.set(next, id);
        files.entries.set(id, { ...entry, name: basename(next), relativePath: next });
      }
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** dirname 的无点版本：顶层条目的父目录相对路径为空串。 */
  const parentRelOf = (relativePath: string): string => {
    const parent = dirname(relativePath);
    return parent === '.' ? '' : parent;
  };

  /** 条目自身的绝对路径：父目录经校验后拼名字，符号链接也只指向链接本身（删除 / 显示 / 复制安全）。 */
  async function pathOf(files: WorkspaceFiles, entry: WorkspaceFileEntry): Promise<string> {
    const parentPath = await checkedPath(files.root, parentRelOf(entry.relativePath));
    return join(parentPath, entry.name);
  }

  async function create(raw: CreateEntryRequest): Promise<EntryResult> {
    const input = parseCreateEntryRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      const name = normalizedName(input.name);
      if (!name) throw new FileAccessError('invalidName');
      const parent = await parentOf(files, input.parentDirectoryId);
      const target = join(parent.path, name);
      if (await exists(target)) throw new FileAccessError('exists');
      try {
        if (input.kind === 'file') {
          const handle = await open(target, 'wx');
          await handle.close();
        } else {
          await mkdir(target);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
          throw new FileAccessError('exists');
        throw error;
      }
      const relativePath = parent.relativePath ? `${parent.relativePath}/${name}` : name;
      return { ok: true, entry: register(files, relativePath, input.kind) };
    } catch (error) {
      return failure(error);
    }
  }

  async function renameEntry(raw: RenameEntryRequest): Promise<EntryResult> {
    const input = parseRenameEntryRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      const entry = find(files, input.entryId);
      const name = normalizedName(input.name);
      if (!name) throw new FileAccessError('invalidName');
      if (name === entry.name) return { ok: true, entry };
      const parentRel = parentRelOf(entry.relativePath);
      const parentPath = await checkedPath(files.root, parentRel);
      const target = join(parentPath, name);
      if (await exists(target)) throw new FileAccessError('exists');
      const source =
        entry.kind === 'symlink'
          ? join(parentPath, entry.name)
          : await checkedPath(files.root, entry.relativePath);
      await rename(source, target);
      const newRel = parentRel ? `${parentRel}/${name}` : name;
      rewritePrefix(files, entry.relativePath, newRel);
      return {
        ok: true,
        entry: files.entries.get(entry.id) ?? { ...entry, name, relativePath: newRel },
      };
    } catch (error) {
      return failure(error);
    }
  }

  async function duplicate(raw: EntryRefRequest): Promise<EntryResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      const entry = find(files, input.entryId);
      if (entry.kind !== 'file') throw new FileAccessError('notFile');
      const source = await checkedPath(files.root, entry.relativePath);
      const parentRel = parentRelOf(entry.relativePath);
      const parentPath = await checkedPath(files.root, parentRel);
      const ext = extname(entry.name);
      const stem = ext ? entry.name.slice(0, -ext.length) : entry.name;
      let name = `${stem} copy${ext}`;
      for (let n = 2; await exists(join(parentPath, name)); n++) {
        if (n > 99) throw new FileAccessError('exists');
        name = `${stem} copy ${n}${ext}`;
      }
      await copyFile(source, join(parentPath, name));
      const relativePath = parentRel ? `${parentRel}/${name}` : name;
      return { ok: true, entry: register(files, relativePath, 'file') };
    } catch (error) {
      return failure(error);
    }
  }

  async function remove(raw: EntryRefRequest): Promise<MutationResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      const entry = find(files, input.entryId);
      const target = await pathOf(files, entry);
      await shell.trash(target);
      rewritePrefix(files, entry.relativePath, null);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async function reveal(raw: EntryRefRequest): Promise<MutationResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      shell.reveal(await pathOf(files, await find(files, input.entryId)));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async function copy(raw: EntryRefRequest): Promise<MutationResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      shell.copyFiles([await pathOf(files, await find(files, input.entryId))]);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async function resolve(raw: EntryRefRequest): Promise<ResolveResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      return { ok: true, path: await pathOf(files, await find(files, input.entryId)) };
    } catch (error) {
      return failure(error);
    }
  }

  async function openHtml(raw: unknown): Promise<MutationResult> {
    const input = parseEntryRefRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      const files = await workspace(input.workspaceId);
      const entry = find(files, input.entryId);
      if (entry.kind !== 'file') throw new FileAccessError('notFile');
      if (!/\.html?$/i.test(entry.name)) throw new FileAccessError('notHtml');
      const path = await checkedPath(files.root, entry.relativePath);
      if (!(await lstat(path)).isFile()) throw new FileAccessError('notFile');
      if (!/\.html?$/i.test(path)) throw new FileAccessError('notHtml');
      const url = pathToFileURL(path);
      // 不把网络共享路径或 Renderer 提供的 URL 交给系统协议处理器。
      if (url.hostname) throw new FileAccessError('outsideWorkspace');
      if ((await checkedPath(files.root, entry.relativePath)) !== path)
        throw new FileAccessError('conflict');
      await shell.openExternal(url.href);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  return {
    /** Main-only persistence adapter. Renderer cannot submit a relative path here. */
    async describeEntry(workspaceId: string, fileId: string): Promise<WorkspaceFileEntry> {
      return { ...find(await workspace(workspaceId), fileId) };
    },
    async restoreEntry(workspaceId: string, relativePath: string): Promise<WorkspaceFileEntry> {
      if (
        !relativePath ||
        relativePath.length > 4096 ||
        relativePath.includes('\\') ||
        relativePath.includes(':') ||
        relativePath.includes('\0') ||
        isAbsolute(relativePath) ||
        relativePath.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new FileAccessError('outsideWorkspace');
      // Registration does not read the file. Every later read/write rechecks realpath,
      // including missing files and parents replaced by links while the app was closed.
      return register(await workspace(workspaceId), relativePath, 'file');
    },
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

    create,
    rename: renameEntry,
    duplicate,
    remove,
    reveal,
    copy,
    resolve,
    openHtml,
  };
}
