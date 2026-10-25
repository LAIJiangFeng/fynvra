import type {
  DirectoryRequest,
  DirectoryResult,
  FileRequest,
  FileResult,
  FileWriteRequest,
  FileWriteResult,
} from '@shared/types/files';
import { IPC_CHANNELS } from '@shared/types/ipc';

export interface FilesApi {
  list(input: DirectoryRequest): Promise<DirectoryResult>;
  read(input: FileRequest): Promise<FileResult>;
  write(input: FileWriteRequest): Promise<FileWriteResult>;
}

export function createFilesApi(ipc: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}): FilesApi {
  return {
    list: ({ workspaceId, directoryId }) =>
      ipc.invoke(IPC_CHANNELS.FILES_LIST, {
        workspaceId,
        ...(directoryId !== undefined ? { directoryId } : {}),
      }) as Promise<DirectoryResult>,
    read: ({ workspaceId, fileId }) =>
      ipc.invoke(IPC_CHANNELS.FILES_READ, { workspaceId, fileId }) as Promise<FileResult>,
    write: ({ workspaceId, fileId, version, text }) =>
      ipc.invoke(IPC_CHANNELS.FILES_WRITE, {
        workspaceId,
        fileId,
        version,
        text,
      }) as Promise<FileWriteResult>,
  };
}
