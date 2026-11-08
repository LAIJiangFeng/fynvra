import {
  hasControl,
  isAbsoluteChatPath,
  nativeChatPath,
  parseChatFilePath,
} from '@shared/chatFilePath';
import type { SessionSummary } from '@shared/types/chat';
import type { OutsideFileError, WorkspaceFileEntry } from '@shared/types/files';
import type { FilesApi } from '../../preload/domains/files';

export type ChatFileContext = Pick<SessionSummary, 'id' | 'workspaceId' | 'cwd' | 'worktreeId'>;
export type ChatLinkError =
  | OutsideFileError
  | 'unsupportedRoot'
  | 'truncated'
  | 'tabLimit'
  | 'restartRequired';

/** outsidePath：工作区外文件的本机路径，错误文案里展示给用户。 */
export class ChatFileLinkError extends Error {
  constructor(
    readonly code: ChatLinkError,
    readonly outsidePath?: string
  ) {
    super(code);
  }
}

const fail = (code: ChatLinkError): never => {
  throw new ChatFileLinkError(code);
};

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

/** 规则见 `@shared/chatFilePath`（Main 的 files:open-outside 用同一规则重新解析）。 */
export function chatFilePath(reference: string): string {
  const parsed = parseChatFilePath(reference);
  return parsed.ok ? parsed.path : fail(parsed.error);
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

export type ChatLinkTarget =
  | { kind: 'inside'; entry: WorkspaceFileEntry }
  /** path：本机写法的绝对路径，只用于展示 / 复制，打开时 Main 由原始 reference 重新解析 */
  | { kind: 'outside'; path: string };

/** 工作区内解析为签发条目；指向工作区（或 worktree root）之外的绝对路径归为 outside，其余错误不变。 */
export async function locateChatFile(
  api: Pick<FilesApi, 'list' | 'resolve'>,
  context: ChatFileContext,
  reference: string
): Promise<ChatLinkTarget> {
  const path = chatFilePath(reference);
  try {
    return { kind: 'inside', entry: await resolveChatFile(api, context, reference) };
  } catch (error) {
    if (
      error instanceof ChatFileLinkError &&
      (error.code === 'outsideWorkspace' || error.code === 'unsupportedRoot') &&
      isAbsoluteChatPath(path)
    )
      return { kind: 'outside', path: nativeChatPath(path) };
    throw error;
  }
}

/** 工作区外的文件只传会话 id 与原始 reference，由 Main 重新解析校验后打开或在文件夹中显示。 */
export async function openOutsideChatFile(
  api: Partial<Pick<FilesApi, 'openOutside'>>,
  context: ChatFileContext,
  reference: string,
  path: string,
  action: 'open' | 'reveal'
): Promise<{ revealed: boolean }> {
  if (!api.openOutside) return fail('restartRequired');
  const result = await api.openOutside({ sessionId: context.id, reference, action });
  if (!result.ok) throw new ChatFileLinkError(result.error, path);
  return { revealed: !!result.revealed };
}

/** 工作区在点击时绑定；异步期间切换工作区不会改变任何请求的归属。 */
export async function openChatFileLink(
  api: Pick<FilesApi, 'list' | 'resolve' | 'openHtml'> & Partial<Pick<FilesApi, 'openOutside'>>,
  context: ChatFileContext,
  reference: string,
  openFile: (workspaceId: string, entry: WorkspaceFileEntry) => Promise<void>,
  isCurrent: () => boolean = () => true
): Promise<{ revealed: boolean }> {
  const target = await locateChatFile(api, context, reference);
  if (!isCurrent()) return { revealed: false };
  if (target.kind === 'outside')
    return openOutsideChatFile(api, context, reference, target.path, 'open');
  const { entry } = target;
  if (/\.html?$/i.test(entry.name)) {
    const result = await api.openHtml({ workspaceId: context.workspaceId, entryId: entry.id });
    if (!result.ok) fail(result.error);
  } else await openFile(context.workspaceId, entry);
  return { revealed: false };
}
