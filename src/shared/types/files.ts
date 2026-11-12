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
  | 'notHtml'
  | 'tooLarge'
  | 'conflict'
  | 'unavailable'
  | 'invalidName'
  | 'exists';

export interface TextFilePreview {
  kind: 'text';
  text: string;
  size: number;
  version: string;
  /** 超过可编辑上限的大文本只读打开，保存会被 Main 拒绝。 */
  readOnly?: true;
}

export type FilePreview = { size: number } & (
  | TextFilePreview
  | { kind: 'image'; dataUrl: string }
  /** 只读文档：原始字节经 IPC 结构化克隆传输，Renderer 解析，不可保存。 */
  | { kind: 'pdf'; data: Uint8Array }
  /** convertedFrom：旧版 .doc 经本机 Word 转换而来。 */
  | { kind: 'docx'; data: Uint8Array; convertedFrom?: 'doc' }
  /** 旧版 .doc：Main 提取的正文，只读，不能当作可编辑文本；conversion 为转换未成功的原因。 */
  | { kind: 'document-text'; format: 'doc'; text: string; conversion?: 'unavailable' | 'failed' }
  | { kind: 'unsupported'; reason: 'binary' | 'tooLarge' | 'unreadable' }
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

/** 新建空文件 / 空子目录：目录用 Main 签发的 id（缺省为根），名称由 Main 校验。 */
export interface CreateEntryRequest {
  workspaceId: string;
  parentDirectoryId?: string;
  name: string;
  kind: 'file' | 'directory';
}

/** 同目录内重命名：条目 id 不变。 */
export interface RenameEntryRequest {
  workspaceId: string;
  entryId: string;
  name: string;
}

/** 指向文件或目录的条目引用（删除 / 显示 / 复制 / 解析路径 / 在浏览器打开 HTML）。 */
export interface EntryRefRequest {
  workspaceId: string;
  entryId: string;
}

/**
 * 打开聊天里指向工作区外的本地文件 / 目录（files:open-outside）。只收会话 id 与原始链接，
 * Main 重新解析、校验，不信任 Renderer 的结论。
 */
export interface OpenOutsideRequest {
  sessionId: string;
  reference: string;
  action: 'open' | 'reveal';
}
export type OutsideFileError =
  | FileError
  | 'invalidLink'
  | 'unsupportedParameters'
  | 'sessionUnavailable'
  | 'openFailed';
/** revealed：未直接打开（非白名单扩展名），改为在文件夹中显示。 */
export type OpenOutsideResult =
  | { ok: true; revealed?: boolean }
  | { ok: false; error: OutsideFileError };

export function parseOpenOutsideRequest(raw: unknown): OpenOutsideRequest | null {
  const input = asRecord(raw);
  if (
    !input ||
    Object.keys(input).some((key) => !['sessionId', 'reference', 'action'].includes(key)) ||
    typeof input.sessionId !== 'string' ||
    !input.sessionId ||
    input.sessionId.length > 200 ||
    typeof input.reference !== 'string' ||
    !input.reference ||
    input.reference.length > 4096 ||
    (input.action !== 'open' && input.action !== 'reveal')
  )
    return null;
  return { sessionId: input.sessionId, reference: input.reference, action: input.action };
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: FileError };
export type DirectoryResult = Result<{ entries: WorkspaceFileEntry[]; truncated: boolean }>;
export type FileResult = Result<{ preview: FilePreview }>;
export type FileWriteResult = Result<{ preview: TextFilePreview }>;
export type EntryResult = Result<{ entry: WorkspaceFileEntry }>;
export type ResolveResult = Result<{ path: string }>;
export type MutationResult = { ok: true } | { ok: false; error: FileError };

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

function parseEntryRequest(
  raw: unknown,
  keys: readonly string[]
): {
  workspaceId: string;
  entryId: string;
} | null {
  const input = asRecord(raw);
  const workspaceId = parseWorkspaceId(input?.workspaceId);
  const entryId = parseWorkspaceId(input?.entryId);
  if (!input || !workspaceId || !entryId || Object.keys(input).some((key) => !keys.includes(key)))
    return null;
  return { workspaceId, entryId };
}

export function parseEntryRefRequest(raw: unknown): EntryRefRequest | null {
  return parseEntryRequest(raw, ['workspaceId', 'entryId']);
}

export function parseRenameEntryRequest(raw: unknown): RenameEntryRequest | null {
  const input = asRecord(raw);
  const ids = parseEntryRequest(input, ['workspaceId', 'entryId', 'name']);
  if (!ids || typeof input?.name !== 'string' || input.name.length > 200) return null;
  return { ...ids, name: input.name };
}

export function parseCreateEntryRequest(raw: unknown): CreateEntryRequest | null {
  const input = asRecord(raw);
  const workspaceId = parseWorkspaceId(input?.workspaceId);
  const parentDirectoryId =
    input?.parentDirectoryId === undefined ? undefined : parseWorkspaceId(input.parentDirectoryId);
  if (
    !input ||
    !workspaceId ||
    (input.parentDirectoryId !== undefined && parentDirectoryId === undefined) ||
    Object.keys(input).some(
      (key) => !['workspaceId', 'parentDirectoryId', 'name', 'kind'].includes(key)
    ) ||
    typeof input.name !== 'string' ||
    input.name.length > 200 ||
    (input.kind !== 'file' && input.kind !== 'directory')
  )
    return null;
  return {
    workspaceId,
    ...(parentDirectoryId ? { parentDirectoryId } : {}),
    name: input.name,
    kind: input.kind,
  };
}
