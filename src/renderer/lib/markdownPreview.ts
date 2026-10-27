import type { WorkspaceFileEntry } from '@shared/types/files';
import type { FilesApi } from '../../preload/domains/files';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 路径只在 Renderer 用于匹配 list 返回的名称，绝不作为 IPC 文件参数。 */
function referenceParts(sourcePath: string, reference: string): string[] | null {
  if (!reference || reference.length > 4096 || reference.trim() !== reference) return null;
  let path: string;
  try {
    path = decodeURIComponent(reference.split(/[?#]/, 1)[0]).replace(/\\/g, '/');
  } catch {
    return null;
  }
  if (
    !path ||
    path.startsWith('/') ||
    path.includes(':') ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;

  const parts = sourcePath.replace(/\\/g, '/').split('/');
  parts.pop();
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 && parts.length <= 64 ? parts : null;
}

/** 缓存同时复用在途 Promise；容量固定，随所属 Markdown 预览释放。 */
function cached<T>(
  cache: Map<string, Promise<T | null>>,
  key: string,
  limit: number,
  load: () => Promise<T | null>
): Promise<T | null> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load().catch(() => null);
  if (cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, pending);
  return pending;
}

/** 绑定 store 的工作区和源文件目录，不读取全局工作区，也不修改文件/会话状态。 */
export function createMarkdownReferences(
  api: FilesApi | undefined,
  workspaceId: string,
  sourcePath: string
) {
  const directories = new Map<string, Promise<WorkspaceFileEntry[] | null>>();
  const images = new Map<string, Promise<string | null>>();
  const partsOf = (reference: string) =>
    sourcePath ? referenceParts(sourcePath, reference) : null;

  async function resolve(parts: string[]): Promise<WorkspaceFileEntry | null> {
    if (!api) return null;
    let directoryId: string | undefined;
    for (const [index, name] of parts.entries()) {
      const parentId = directoryId;
      const entries = await cached(directories, parentId ?? '', 32, async () => {
        const result = await api.list({
          workspaceId,
          ...(parentId ? { directoryId: parentId } : {}),
        });
        return result.ok ? result.entries : null;
      });
      const entry = entries?.find((candidate) => candidate.name === name);
      if (!entry) return null;
      if (index === parts.length - 1) return entry.kind === 'file' ? entry : null;
      if (entry.kind !== 'directory') return null;
      directoryId = entry.id;
    }
    return null;
  }

  return {
    isLocal(reference: string): boolean {
      return partsOf(reference) !== null;
    },
    async resolveFile(reference: string): Promise<WorkspaceFileEntry | null> {
      const parts = partsOf(reference);
      return parts ? resolve(parts) : null;
    },
    async readImage(reference: string): Promise<string | null> {
      const parts = partsOf(reference);
      if (!parts || !api) return null;
      return cached(images, parts.join('/'), 8, async () => {
        const entry = await resolve(parts);
        if (!entry) return null;
        const result = await api.read({ workspaceId, fileId: entry.id });
        if (!result.ok || result.preview.kind !== 'image') return null;
        const { size, dataUrl } = result.preview;
        // 只有 Main 按文件签名识别且受 2 MiB 限制的栅格图像可以进入 img.src。
        return size > 0 &&
          size <= MAX_IMAGE_BYTES &&
          dataUrl.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32 &&
          /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
          ? dataUrl
          : null;
      });
    },
  };
}

export type MarkdownReferences = ReturnType<typeof createMarkdownReferences>;
