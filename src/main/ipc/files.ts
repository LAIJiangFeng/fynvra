import {
  type DirectoryResult,
  type FileResult,
  type FileWriteResult,
  parseDirectoryRequest,
  parseFileRequest,
  parseWriteRequest,
} from '@shared/types/files';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { ipcMain } from 'electron';
import { createFilesService } from '../services/files';
import { getWorkspaceService } from './workspaces';

export function registerFilesHandlers(): void {
  const service = createFilesService({ getWorkspace: (id) => getWorkspaceService().get(id) });
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
}
