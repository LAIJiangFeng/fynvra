import {
  type DirectoryResult,
  type EntryRefRequest,
  type EntryResult,
  type FileResult,
  type FileWriteResult,
  type MutationResult,
  parseCreateEntryRequest,
  parseDirectoryRequest,
  parseEntryRefRequest,
  parseFileRequest,
  parseRenameEntryRequest,
  parseWriteRequest,
  type ResolveResult,
} from '@shared/types/files';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { ClipboardItem, clipboard, ipcMain, shell } from 'electron';
import { createFilesService, type FilesShell } from '../services/files';
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
};

export function registerFilesHandlers(): void {
  const service = createFilesService({
    getWorkspace: (id) => getWorkspaceService().get(id),
    shell: shellAdapter,
  });
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
    ): ((raw: unknown) => Promise<MutationResult>) =>
    async (raw: unknown) => {
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
