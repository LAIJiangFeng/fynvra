import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve as resolvePath } from 'node:path';
import { isAbsoluteChatPath, parseChatFilePath } from '@shared/chatFilePath';
import {
  type DirectoryResult,
  type EntryRefRequest,
  type EntryResult,
  type FileResult,
  type FileWriteResult,
  type MutationResult,
  type OpenOutsideRequest,
  type OpenOutsideResult,
  parseCreateEntryRequest,
  parseDirectoryRequest,
  parseEntryRefRequest,
  parseFileRequest,
  parseOpenOutsideRequest,
  parseRenameEntryRequest,
  parseWriteRequest,
  type ResolveResult,
} from '@shared/types/files';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, ClipboardItem, clipboard, ipcMain, shell } from 'electron';
import { createFilesService, type FilesShell } from '../services/files';
import { createWordConverter } from '../services/wordConversion';
import { getWorkspaceService } from './workspaces';

/**
 * Windows：CF_HDROP（DROPFILES + UTF-16 双空结尾路径表）写进剪贴板，可粘贴到资源管理器与聊天窗口；
 * 同时写入路径文本，不认文件格式的目标也能粘贴。其他平台没有等价的系统文件剪贴板，退回路径文本。
 * ponytail: 只写 CF_HDROP 一种文件格式，遇到只认 FileGroupDescriptorW 的应用再补。
 */
function copyFilesToClipboard(paths: string[]): void {
  const text = paths.join('\n');
  if (process.platform !== 'win32') {
    void clipboard.writeText(text);
    return;
  }
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0); // pFiles：路径表从第 20 字节开始
  header.writeUInt32LE(1, 16); // fWide：UTF-16
  const list = Buffer.from(`${paths.join('\0')}\0\0`, 'utf16le');
  try {
    const hdrop = new Blob([new Uint8Array(Buffer.concat([header, list]))]);
    const item = new ClipboardItem({
      'text/plain': text,
      'electron application/osclipboard;format="CF_HDROP"': hdrop,
    });
    clipboard.write([item]).catch(() => void clipboard.writeText(text));
  } catch {
    void clipboard.writeText(text);
  }
}

const shellAdapter: FilesShell = {
  reveal: (path) => shell.showItemInFolder(path),
  copyFiles: copyFilesToClipboard,
  trash: (path) => shell.trashItem(path),
  openExternal: (url) => shell.openExternal(url),
};

/**
 * 工作区外文件只有这些扩展名会交给系统默认应用打开（纯数据格式，Office 仅无宏格式）；
 * 其余一律只在文件夹中显示，绝不执行可执行 / 脚本类文件。
 */
const OUTSIDE_OPENABLE = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif'],
  'pdf',
  ...['txt', 'md', 'markdown', 'log', 'json', 'yaml', 'yml', 'toml', 'ini'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'webm', 'mkv', 'avi'],
  ...['docx', 'xlsx', 'pptx'],
]);

/** UNC（\\server\share、//server）与设备路径（\\?\、\\.\）：可能触发 SMB 连接、泄露凭据。 */
const isUncOrDevice = (path: string) => /^[\\/]{2}/.test(path);

async function sessionExists(sessionId: string): Promise<boolean> {
  // 动态引入：会话模块依赖面大，只在真正打开外部链接时加载
  const { getSessionStore } = await import('./sessions');
  return !!getSessionStore().get(sessionId);
}

/**
 * 会话必须存在；reference 按聊天链接同一规则重新解析，必须是本平台的绝对路径，
 * resolve / readlink / realpath 之后都不得是 UNC 或设备路径。日志不写路径。
 */
export async function openOutsideFile(
  input: OpenOutsideRequest,
  deps: {
    sessionExists(sessionId: string): Promise<boolean>;
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  }
): Promise<OpenOutsideResult> {
  if (!(await deps.sessionExists(input.sessionId)))
    return { ok: false, error: 'sessionUnavailable' };
  const parsed = parseChatFilePath(input.reference);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const windows = process.platform === 'win32';
  // 相对路径属于工作区，走原有流程；Windows 只认盘符路径，POSIX 只认 `/` 路径
  if (
    !isAbsoluteChatPath(parsed.path) ||
    isUncOrDevice(parsed.path) ||
    windows !== /^[a-z]:\//i.test(parsed.path)
  )
    return { ok: false, error: 'invalidLink' };
  const target = resolvePath(windows ? parsed.path.replace(/\//g, '\\') : parsed.path);
  if (isUncOrDevice(target)) return { ok: false, error: 'invalidLink' };
  let real: string;
  let kind: 'file' | 'directory';
  try {
    const link = await lstat(target);
    // 符号链接先看目标写法，指向 UNC 的在访问目标之前就拒绝
    if (link.isSymbolicLink() && isUncOrDevice(await readlink(target)))
      return { ok: false, error: 'invalidLink' };
    real = await realpath(target);
    if (isUncOrDevice(real)) return { ok: false, error: 'invalidLink' };
    const info = await stat(real);
    if (info.isDirectory()) kind = 'directory';
    else if (info.isFile()) kind = 'file';
    else return { ok: false, error: 'notFile' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      error: code === 'ENOENT' || code === 'ENOTDIR' ? 'entryNotFound' : 'unavailable',
    };
  }
  const openPath = async (): Promise<OpenOutsideResult> =>
    (await deps.openPath(real)) ? { ok: false, error: 'openFailed' } : { ok: true };
  if (kind === 'directory') return openPath();
  if (input.action === 'reveal') {
    deps.showItemInFolder(real);
    return { ok: true };
  }
  // 以 realpath 的扩展名为准：链接名伪装成 .png 也不会执行真实的可执行文件
  if (OUTSIDE_OPENABLE.has(extname(real).slice(1).toLowerCase())) return openPath();
  deps.showItemInFolder(real);
  return { ok: true, revealed: true };
}

let filesService: ReturnType<typeof createFilesService> | undefined;
export function getFilesService(): ReturnType<typeof createFilesService> {
  filesService ??= createFilesService({
    getWorkspace: (id) => getWorkspaceService().get(id),
    shell: shellAdapter,
    convertDoc: createWordConverter({
      cacheDir: join(app.getPath('userData'), 'cache', 'doc-preview'),
    }).convert,
  });
  return filesService;
}

export function registerFilesHandlers(): void {
  const service = getFilesService();
  ipcMain.handle(
    IPC_CHANNELS.FILES_LIST,
    async (_event, raw: unknown): Promise<DirectoryResult> => {
      const input = parseDirectoryRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await service.list(input);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.FILES_READ, async (_event, raw: unknown): Promise<FileResult> => {
    const input = parseFileRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      return await service.read(input);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.FILES_WRITE,
    async (_event, raw: unknown): Promise<FileWriteResult> => {
      const input = parseWriteRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await service.write(input);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.FILES_CREATE, async (_event, raw: unknown): Promise<EntryResult> => {
    const input = parseCreateEntryRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      return await service.create(input);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  });
  ipcMain.handle(IPC_CHANNELS.FILES_RENAME, async (_event, raw: unknown): Promise<EntryResult> => {
    const input = parseRenameEntryRequest(raw);
    if (!input) return { ok: false, error: 'invalidRequest' };
    try {
      return await service.rename(input);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.FILES_DUPLICATE,
    async (_event, raw: unknown): Promise<EntryResult> => {
      const input = parseEntryRefRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await service.duplicate(input);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );
  const mutating =
    (
      invoke: (input: EntryRefRequest) => Promise<MutationResult>
    ): ((_event: unknown, raw: unknown) => Promise<MutationResult>) =>
    async (_event: unknown, raw: unknown) => {
      const input = parseEntryRefRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await invoke(input);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    };
  ipcMain.handle(
    IPC_CHANNELS.FILES_DELETE,
    mutating((input) => service.remove(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.FILES_REVEAL,
    mutating((input) => service.reveal(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.FILES_COPY,
    mutating((input) => service.copy(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.FILES_OPEN_HTML,
    mutating((input) => service.openHtml(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.FILES_OPEN_OUTSIDE,
    async (_event, raw: unknown): Promise<OpenOutsideResult> => {
      const input = parseOpenOutsideRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await openOutsideFile(input, {
          sessionExists,
          openPath: (path) => shell.openPath(path),
          showItemInFolder: (path) => shell.showItemInFolder(path),
        });
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.FILES_RESOLVE,
    async (_event, raw: unknown): Promise<ResolveResult> => {
      const input = parseEntryRefRequest(raw);
      if (!input) return { ok: false, error: 'invalidRequest' };
      try {
        return await service.resolve(input);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );
}
