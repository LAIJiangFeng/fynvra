import type {
  CreateEntryRequest,
  DirectoryRequest,
  DirectoryResult,
  EntryRefRequest,
  EntryResult,
  FileRequest,
  FileResult,
  FileWriteRequest,
  FileWriteResult,
  MutationResult,
  RenameEntryRequest,
  ResolveResult,
} from '@shared/types/files';
import { IPC_CHANNELS } from '@shared/types/ipc';

export interface FilesApi {
  list(input: DirectoryRequest): Promise<DirectoryResult>;
  read(input: FileRequest): Promise<FileResult>;
  write(input: FileWriteRequest): Promise<FileWriteResult>;
  create(input: CreateEntryRequest): Promise<EntryResult>;
  rename(input: RenameEntryRequest): Promise<EntryResult>;
  duplicate(input: EntryRefRequest): Promise<EntryResult>;
  remove(input: EntryRefRequest): Promise<MutationResult>;
  reveal(input: EntryRefRequest): Promise<MutationResult>;
  copy(input: EntryRefRequest): Promise<MutationResult>;
  resolve(input: EntryRefRequest): Promise<ResolveResult>;
}

export function createFilesApi(ipc: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}): FilesApi {
  const entryRef = (input: EntryRefRequest) => ({
    workspaceId: input.workspaceId,
    entryId: input.entryId,
  });
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
    create: ({ workspaceId, parentDirectoryId, name, kind }) =>
      ipc.invoke(IPC_CHANNELS.FILES_CREATE, {
        workspaceId,
        ...(parentDirectoryId !== undefined ? { parentDirectoryId } : {}),
        name,
        kind,
      }) as Promise<EntryResult>,
    rename: ({ workspaceId, entryId, name }) =>
      ipc.invoke(IPC_CHANNELS.FILES_RENAME, { workspaceId, entryId, name }) as Promise<EntryResult>,
    duplicate: (input) =>
      ipc.invoke(IPC_CHANNELS.FILES_DUPLICATE, entryRef(input)) as Promise<EntryResult>,
    remove: (input) =>
      ipc.invoke(IPC_CHANNELS.FILES_DELETE, entryRef(input)) as Promise<MutationResult>,
    reveal: (input) =>
      ipc.invoke(IPC_CHANNELS.FILES_REVEAL, entryRef(input)) as Promise<MutationResult>,
    copy: (input) =>
      ipc.invoke(IPC_CHANNELS.FILES_COPY, entryRef(input)) as Promise<MutationResult>,
    resolve: (input) =>
      ipc.invoke(IPC_CHANNELS.FILES_RESOLVE, entryRef(input)) as Promise<ResolveResult>,
  };
}
