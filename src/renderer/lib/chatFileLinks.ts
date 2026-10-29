import type { SessionSummary } from '@shared/types/chat';
import type { FileError, WorkspaceFileEntry } from '@shared/types/files';
import type { FilesApi } from '../../preload/domains/files';

export type ChatFileContext = Pick<SessionSummary, 'id' | 'workspaceId' | 'cwd' | 'worktreeId'>;
export type ChatLinkError =
  | FileError
  | 'invalidLink'
  | 'unsupportedRoot'
  | 'unsupportedParameters'
  | 'truncated'
  | 'sessionUnavailable'
  | 'tabLimit'
  | 'restartRequired';

export class ChatFileLinkError extends Error {
  constructor(readonly code: ChatLinkError) {
    super(code);
  }
}

const fail = (code: ChatLinkError): never => {
  throw new ChatFileLinkError(code);
};
const hasControl = (text: string) =>
  Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** 只有显式 http(s) 能成为 DOM href；本地及被拒绝的链接都走按钮。 */
export function externalChatLink(reference: string): string | null {
  if (!/^https?:\/\//i.test(reference) || hasControl(reference)) return null;
  try {
    const url = new URL(reference);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 不支持网页 query/hash；编码过的 %23 / %3F 仍是文件名，不是展示参数。 */
export function chatFilePath(reference: string): string {
  if (
    !reference ||
    reference.length > 4096 ||
    reference.trim() !== reference ||
    hasControl(reference) ||
    reference.startsWith('#')
  )
    return fail('invalidLink');
  if (/[?#]/.test(reference)) return fail('unsupportedParameters');
  let path = reference;
  const fileUrl = /^file:/i.test(path);
  if (fileUrl) {
    try {
      const url = new URL(path);
      if (
        url.protocol !== 'file:' ||
        (url.hostname && url.hostname !== 'localhost') ||
        url.username ||
        url.password ||
        url.port
      )
        return fail('invalidLink');
      path = url.pathname;
    } catch {
      return fail('invalidLink');
    }
  }
  try {
    path = decodeURIComponent(path).replace(/\\/g, '/');
    if (fileUrl) path = path.replace(/^\/(?=[a-z]:\/)/i, '');
  } catch {
    return fail('invalidLink');
  }
  // 带扩展名的 path:line 可以与 URI 区分；未知协议绝不退化成文件名。
  if (
    /^[a-z][a-z\d+.-]*:/i.test(path) &&
    !/^[a-z]:\//i.test(path) &&
    !/^[^:]+\.[^:]+:\d+(?::\d+)?$/.test(path)
  )
    return fail('invalidLink');
  // 定位仅用于显示；打开文件不改变现有编辑器的光标/草稿。
  path = path.replace(/:\d+(?::\d+)?$/, '');
  const withoutDrive = path.replace(/^[a-z]:\//i, '');
  if (
    !path ||
    hasControl(path) ||
    path.startsWith('//') ||
    withoutDrive.includes(':') ||
    path.startsWith('~')
  )
    return fail('invalidLink');
  return path;
}

interface AbsolutePath {
  volume: string;
  parts: string[];
}

function absolutePath(path: string): AbsolutePath | null {
  path = path.replace(/\\/g, '/');
  if (path.startsWith('//') || hasControl(path)) return null;
  const volume = /^[a-z]:\//i.test(path)
    ? path.slice(0, 2).toLowerCase()
    : path[0] === '/'
      ? '/'
      : '';
  if (!volume) return null;
  const parts: string[] = [];
  for (const part of path.slice(volume === '/' ? 1 : 3).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      if (part.includes(':')) return null;
      parts.push(part);
    }
  }
  return { volume, parts };
}

function sameName(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(root: AbsolutePath, path: AbsolutePath): boolean {
  return (
    root.volume === path.volume &&
    root.parts.length <= path.parts.length &&
    root.parts.every((part, index) => sameName(part, path.parts[index], root.volume !== '/'))
  );
}

/** 仅在 Renderer 做名称匹配，结果从不作为路径参数回传 Main。 */
export function chatFileParts(
  rootPath: string,
  context: ChatFileContext,
  path: string
): { parts: string[]; windows: boolean } {
  const root = absolutePath(rootPath);
  if (!root) return fail('unsupportedRoot');
  const target = absolutePath(path);
  let parts: string[];
  if (target) {
    if (!within(root, target))
      return fail(context.worktreeId ? 'unsupportedRoot' : 'outsideWorkspace');
    parts = target.parts.slice(root.parts.length);
  } else {
    // 绝对但无法规范化的路径不能退化为相对引用。
    if (path.startsWith('/') || /^[a-z]:/i.test(path)) return fail('invalidLink');
    const cwd = absolutePath(context.cwd);
    if (!cwd || !within(root, cwd)) return fail('unsupportedRoot');
    parts = cwd.parts.slice(root.parts.length);
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return fail('outsideWorkspace');
        parts.pop();
      } else parts.push(part);
    }
  }
  if (!parts.length || parts.length > 64) return fail('invalidLink');
  return { parts, windows: root.volume !== '/' };
}

/** 只在点击时列目录。通过已签发 id 获取实际 root，不依赖缩写的 displayPath。 */
export async function resolveChatFile(
  api: Pick<FilesApi, 'list' | 'resolve'>,
  context: ChatFileContext,
  reference: string
): Promise<WorkspaceFileEntry> {
  const path = chatFilePath(reference);
  const { workspaceId } = context;
  const top = await api.list({ workspaceId });
  if (!top.ok) return fail(top.error);
  const first = top.entries[0];
  if (!first) return fail('entryNotFound');
  const resolved = await api.resolve({ workspaceId, entryId: first.id });
  if (!resolved.ok) return fail(resolved.error);
  const fullPath = resolved.path.replace(/\\/g, '/');
  if (!fullPath.endsWith(`/${first.name}`)) return fail('unsupportedRoot');
  const root = fullPath.slice(0, -first.name.length);
  const { parts, windows } = chatFileParts(root, context, path);
  let directory = top;
  for (const [index, name] of parts.entries()) {
    const exact = directory.entries.find((entry) => entry.name === name);
    const matches = directory.entries.filter((entry) => sameName(entry.name, name, windows));
    const entry = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!entry) return fail(directory.truncated ? 'truncated' : 'entryNotFound');
    if (index === parts.length - 1) {
      if (entry.kind !== 'file') return fail('notFile');
      return entry;
    }
    if (entry.kind !== 'directory') return fail('notDirectory');
    const next = await api.list({ workspaceId, directoryId: entry.id });
    if (!next.ok) return fail(next.error);
    directory = next;
  }
  return fail('entryNotFound');
}

/** 工作区在点击时绑定；异步期间切换工作区不会改变任何请求的归属。 */
export async function openChatFileLink(
  api: Pick<FilesApi, 'list' | 'resolve' | 'openHtml'>,
  context: ChatFileContext,
  reference: string,
  openFile: (workspaceId: string, entry: WorkspaceFileEntry) => Promise<void>,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const entry = await resolveChatFile(api, context, reference);
  if (!isCurrent()) return;
  if (/\.html?$/i.test(entry.name)) {
    const result = await api.openHtml({ workspaceId: context.workspaceId, entryId: entry.id });
    if (!result.ok) fail(result.error);
  } else await openFile(context.workspaceId, entry);
}
