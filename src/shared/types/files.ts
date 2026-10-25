import { asRecord } from '../guards';
import { parseWorkspaceId } from './workspace';

export interface WorkspaceFileEntry {
  id: string;
  name: string;
  /** 仅供展示，不能作为文件访问参数回传 Main。 */
  relativePath: string;
  kind: 'directory' | 'file' | 'symlink';
}

export type FileError =
  | 'invalidRequest'
  | 'workspaceNotFound'
  | 'entryNotFound'
  | 'outsideWorkspace'
  | 'notDirectory'
  | 'notFile'
  | 'notText'
  | 'tooLarge'
  | 'conflict'
  | 'unavailable';

export interface TextFilePreview {
  kind: 'text';
  text: string;
  size: number;
  version: string;
}

export type FilePreview = { size: number } & (
  | TextFilePreview
  | { kind: 'image'; dataUrl: string }
  | { kind: 'unsupported'; reason: 'binary' | 'tooLarge' }
);

export interface DirectoryRequest {
  workspaceId: string;
  directoryId?: string;
}
export interface FileRequest {
  workspaceId: string;
  fileId: string;
}

export interface FileWriteRequest extends FileRequest {
  version: string;
  text: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: FileError };
export type DirectoryResult = Result<{ entries: WorkspaceFileEntry[]; truncated: boolean }>;
export type FileResult = Result<{ preview: FilePreview }>;
export type FileWriteResult = Result<{ preview: TextFilePreview }>;

export function parseDirectoryRequest(raw: unknown): DirectoryRequest | null {
  const input = asRecord(raw);
  const workspaceId = parseWorkspaceId(input?.workspaceId);
  if (
    !input ||
    !workspaceId ||
    Object.keys(input).some((key) => !['workspaceId', 'directoryId'].includes(key))
  )
    return null;
  if (input.directoryId === undefined) return { workspaceId };
  const directoryId = parseWorkspaceId(input.directoryId);
  return directoryId ? { workspaceId, directoryId } : null;
}

export function parseFileRequest(raw: unknown): FileRequest | null {
  const input = asRecord(raw);
  const workspaceId = parseWorkspaceId(input?.workspaceId);
  const fileId = parseWorkspaceId(input?.fileId);
  if (
    !input ||
    !workspaceId ||
    !fileId ||
    Object.keys(input).some((key) => !['workspaceId', 'fileId'].includes(key))
  )
    return null;
  return { workspaceId, fileId };
}

export function parseWriteRequest(raw: unknown): FileWriteRequest | null {
  const input = asRecord(raw);
  const ids = parseFileRequest({ workspaceId: input?.workspaceId, fileId: input?.fileId });
  if (
    !input ||
    !ids ||
    Object.keys(input).some((key) => !['workspaceId', 'fileId', 'version', 'text'].includes(key)) ||
    typeof input.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.version) ||
    typeof input.text !== 'string' ||
    input.text.length > 256 * 1024
  )
    return null;
  return { ...ids, version: input.version, text: input.text };
}
