import type {
  EntryResult,
  FileError,
  FilePreview,
  MutationResult,
  ResolveResult,
  WorkspaceFileEntry,
} from '@shared/types/files';
import { create } from 'zustand';
import type { FilesApi } from '../../preload/domains/files';

export const ROOT_DIRECTORY_ID = 'root';
type FilesViewError = FileError | 'restartRequired';
type MutateResult<T> = T | { ok: false; error: 'restartRequired' };

export interface DirectoryState {
  entries: WorkspaceFileEntry[];
  loading: boolean;
  error: FilesViewError | null;
  truncated: boolean;
}

export type FileMode = 'edit' | 'preview' | 'split';

export interface PreviewState {
  preview: FilePreview | null;
  loading: boolean;
  error: FilesViewError | null;
  draft: string;
  saving: boolean;
  saveError: FilesViewError | null;
  mode: FileMode;
}

export function isFileDirty(state: PreviewState | undefined): boolean {
  return state?.preview?.kind === 'text' && state.draft !== state.preview.text;
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name);
}

export interface FilesState {
  directories: Record<string, DirectoryState>;
  expanded: string[];
  opened: WorkspaceFileEntry[];
  selectedId: string | null;
  previews: Record<string, PreviewState>;
  loadDirectory(directoryId?: string, force?: boolean): Promise<void>;
  toggleDirectory(directoryId: string): Promise<void>;
  openFile(entry: WorkspaceFileEntry): Promise<void>;
  closeFile(fileId: string, discard?: boolean): boolean;
  showChat(): void;
  editFile(fileId: string, text: string): void;
  saveFile(fileId: string): Promise<boolean>;
  reloadFile(fileId: string, discard?: boolean): Promise<void>;
  setMode(fileId: string, mode: FileMode): void;
  refresh(): Promise<void>;
  // 右键菜单背后的条目变更：parentId 是条目所在目录的 id（根目录为 undefined），操作后刷新该目录
  createEntry(
    parentId: string | undefined,
    name: string,
    kind: 'file' | 'directory'
  ): Promise<MutateResult<EntryResult>>;
  renameEntry(
    parentId: string | undefined,
    entry: WorkspaceFileEntry,
    name: string
  ): Promise<MutateResult<EntryResult>>;
  duplicateFile(
    parentId: string | undefined,
    entry: WorkspaceFileEntry
  ): Promise<MutateResult<EntryResult>>;
  deleteEntry(
    parentId: string | undefined,
    entry: WorkspaceFileEntry
  ): Promise<MutateResult<MutationResult>>;
  copyEntry(entry: WorkspaceFileEntry): Promise<MutateResult<MutationResult>>;
  revealEntry(entry: WorkspaceFileEntry): Promise<MutateResult<MutationResult>>;
  resolvePath(entry: WorkspaceFileEntry): Promise<MutateResult<ResolveResult>>;
}

export function createFilesStore(api: FilesApi | undefined, workspaceId: string) {
  const directoryRequests = new Map<string, symbol>();
  const fileRequests = new Map<string, symbol>();

  return create<FilesState>()((set, get) => {
    async function read(fileId: string) {
      const current = get().previews[fileId];
      const name = get().opened.find((file) => file.id === fileId)?.name ?? '';
      const base: PreviewState = current ?? {
        preview: null,
        loading: false,
        error: null,
        draft: '',
        saving: false,
        saveError: null,
        mode: isMarkdown(name) ? 'preview' : 'edit',
      };
      const request = Symbol();
      fileRequests.set(fileId, request);
      const update = (entry: PreviewState) =>
        set((state) => ({ previews: { ...state.previews, [fileId]: entry } }));
      update({ ...base, loading: true, error: null });
      try {
        const result = api
          ? await api.read({ workspaceId, fileId })
          : ({ ok: false, error: 'restartRequired' } as const);
        if (fileRequests.get(fileId) !== request) return;
        const latest = get().previews[fileId] ?? base;
        update(
          result.ok
            ? {
                ...latest,
                preview: result.preview,
                draft: result.preview.kind === 'text' ? result.preview.text : '',
                loading: false,
                error: null,
                saveError: null,
              }
            : { ...latest, preview: null, draft: '', loading: false, error: result.error }
        );
      } catch {
        if (fileRequests.get(fileId) === request)
          update({
            ...(get().previews[fileId] ?? base),
            preview: null,
            draft: '',
            loading: false,
            error: 'unavailable',
          });
      }
    }

    return {
      directories: {},
      expanded: [],
      opened: [],
      selectedId: null,
      previews: {},

      async loadDirectory(directoryId, force = false) {
        const key = directoryId ?? ROOT_DIRECTORY_ID;
        const current = get().directories[key];
        if (!force && current && !current.error) return;
        const request = Symbol();
        directoryRequests.set(key, request);
        const update = (entry: DirectoryState) =>
          set((state) => ({ directories: { ...state.directories, [key]: entry } }));
        update({ entries: current?.entries ?? [], loading: true, error: null, truncated: false });
        try {
          const result = api
            ? await api.list({ workspaceId, ...(directoryId ? { directoryId } : {}) })
            : ({ ok: false, error: 'restartRequired' } as const);
          if (directoryRequests.get(key) !== request) return;
          update(
            result.ok
              ? {
                  entries: result.entries,
                  loading: false,
                  error: null,
                  truncated: result.truncated,
                }
              : { entries: [], loading: false, error: result.error, truncated: false }
          );
        } catch {
          if (directoryRequests.get(key) === request)
            update({ entries: [], loading: false, error: 'unavailable', truncated: false });
        }
      },

      async toggleDirectory(directoryId) {
        if (get().expanded.includes(directoryId)) {
          set((state) => ({ expanded: state.expanded.filter((id) => id !== directoryId) }));
        } else {
          set((state) => ({ expanded: [...state.expanded, directoryId] }));
          await get().loadDirectory(directoryId);
        }
      },

      async openFile(entry) {
        if (entry.kind !== 'file') return;
        if (!get().opened.some((file) => file.id === entry.id)) {
          set((state) => ({ opened: [...state.opened, entry] }));
        }
        set({ selectedId: entry.id });
        const preview = get().previews[entry.id];
        if (!preview || (preview.error && !isFileDirty(preview))) await read(entry.id);
      },

      closeFile(fileId, discard = false) {
        const current = get().previews[fileId];
        if (current?.saving || (isFileDirty(current) && !discard)) return false;
        fileRequests.delete(fileId);
        set((state) => {
          const index = state.opened.findIndex((file) => file.id === fileId);
          const opened = state.opened.filter((file) => file.id !== fileId);
          const previews = { ...state.previews };
          delete previews[fileId];
          return {
            opened,
            previews,
            selectedId:
              state.selectedId === fileId
                ? (opened[Math.min(index, opened.length - 1)]?.id ?? null)
                : state.selectedId,
          };
        });
        return true;
      },

      showChat() {
        set({ selectedId: null });
      },

      editFile(fileId, text) {
        const current = get().previews[fileId];
        if (current?.preview?.kind !== 'text') return;
        fileRequests.delete(fileId);
        set((state) => ({
          previews: { ...state.previews, [fileId]: { ...current, draft: text, loading: false } },
        }));
      },

      setMode(fileId, mode) {
        const current = get().previews[fileId];
        if (current)
          set((state) => ({ previews: { ...state.previews, [fileId]: { ...current, mode } } }));
      },

      async reloadFile(fileId, discard = false) {
        const current = get().previews[fileId];
        if (!current || current.saving || (isFileDirty(current) && !discard)) return;
        await read(fileId);
      },

      async saveFile(fileId) {
        const current = get().previews[fileId];
        if (current?.preview?.kind !== 'text' || current.saving) return false;
        if (!isFileDirty(current)) return true;
        if (new TextEncoder().encode(current.draft).byteLength > 256 * 1024) {
          set((state) => ({
            previews: { ...state.previews, [fileId]: { ...current, saveError: 'tooLarge' } },
          }));
          return false;
        }
        fileRequests.delete(fileId);
        const update = (changes: Partial<PreviewState>) =>
          set((state) => ({
            previews: { ...state.previews, [fileId]: { ...state.previews[fileId], ...changes } },
          }));
        update({ saving: true, saveError: null, loading: false });
        try {
          const result = api?.write
            ? await api.write({
                workspaceId,
                fileId,
                version: current.preview.version,
                text: current.draft,
              })
            : ({ ok: false, error: 'restartRequired' } as const);
          // 保存中仍可编辑：只推进磁盘基线，不覆盖用户后续输入。
          update(
            result.ok
              ? { preview: result.preview, saving: false, saveError: null }
              : { saving: false, saveError: result.error }
          );
          return result.ok;
        } catch {
          update({ saving: false, saveError: 'unavailable' });
          return false;
        }
      },

      async refresh() {
        await Promise.all([
          get().loadDirectory(undefined, true),
          ...get().expanded.map((id) => get().loadDirectory(id, true)),
          ...get().opened.map((file) => get().reloadFile(file.id)),
        ]);
      },

      async createEntry(parentId, name, kind) {
        if (!api) return { ok: false, error: 'restartRequired' };
        const result = await api.create({
          workspaceId,
          ...(parentId !== undefined ? { parentDirectoryId: parentId } : {}),
          name,
          kind,
        });
        if (result.ok) {
          await get().loadDirectory(parentId, true);
          if (kind === 'file') await get().openFile(result.entry);
          else await get().toggleDirectory(result.entry.id);
        }
        return result;
      },

      async renameEntry(parentId, entry, name) {
        if (!api) return { ok: false, error: 'restartRequired' };
        const result = await api.rename({ workspaceId, entryId: entry.id, name });
        if (result.ok) {
          const prefix = `${entry.relativePath}/`;
          const renamed = (path: string) =>
            path === entry.relativePath
              ? result.entry.relativePath
              : path.startsWith(prefix)
                ? `${result.entry.relativePath}${path.slice(entry.relativePath.length)}`
                : path;
          set((state) => ({
            opened: state.opened.map((file) =>
              file.id === entry.id || file.relativePath.startsWith(prefix)
                ? {
                    ...file,
                    name: file.id === entry.id ? result.entry.name : file.name,
                    relativePath: renamed(file.relativePath),
                  }
                : file
            ),
          }));
          await get().loadDirectory(parentId, true);
        }
        return result;
      },

      async duplicateFile(parentId, entry) {
        if (!api) return { ok: false, error: 'restartRequired' };
        const result = await api.duplicate({ workspaceId, entryId: entry.id });
        if (result.ok) await get().loadDirectory(parentId, true);
        return result;
      },

      async deleteEntry(parentId, entry) {
        if (!api) return { ok: false, error: 'restartRequired' };
        const result = await api.remove({ workspaceId, entryId: entry.id });
        if (result.ok) {
          const prefix = `${entry.relativePath}/`;
          const removed = get().opened.filter(
            (file) => file.id === entry.id || file.relativePath.startsWith(prefix)
          );
          const removedIds = new Set(removed.map((file) => file.id));
          set((state) => ({
            opened: state.opened.filter((file) => !removedIds.has(file.id)),
            previews: Object.fromEntries(
              Object.entries(state.previews).filter(([id]) => !removedIds.has(id))
            ),
            expanded: state.expanded.filter((id) => id !== entry.id),
            selectedId:
              state.selectedId !== null && removedIds.has(state.selectedId)
                ? null
                : state.selectedId,
          }));
          for (const file of removed) fileRequests.delete(file.id);
          await get().loadDirectory(parentId, true);
        }
        return result;
      },

      copyEntry(entry) {
        return api
          ? api.copy({ workspaceId, entryId: entry.id })
          : Promise.resolve({ ok: false as const, error: 'restartRequired' as const });
      },

      revealEntry(entry) {
        return api
          ? api.reveal({ workspaceId, entryId: entry.id })
          : Promise.resolve({ ok: false as const, error: 'restartRequired' as const });
      },

      resolvePath(entry) {
        return api
          ? api.resolve({ workspaceId, entryId: entry.id })
          : Promise.resolve({ ok: false as const, error: 'restartRequired' as const });
      },
    };
  });
}

export type FilesStore = ReturnType<typeof createFilesStore>;
const stores = new Map<string, FilesStore>();

/** 切换页签、工作区或收起右栏只隐藏视图，本次运行中保留已打开文件。 */
export function filesStoreFor(workspaceId: string, api: FilesApi | undefined): FilesStore {
  let store = stores.get(workspaceId);
  if (!store) {
    store = createFilesStore(api, workspaceId);
    stores.set(workspaceId, store);
  }
  return store;
}

/** 所有工作区的草稿都参与退出保护，不只检查当前可见文件。 */
export function hasUnsavedFiles(): boolean {
  return [...stores.values()].some((store) =>
    Object.values(store.getState().previews).some(
      (preview) => preview.saving || isFileDirty(preview)
    )
  );
}

export function bindFileUnloadGuard(target: EventTarget): () => void {
  const beforeUnload = (event: Event) => {
    if (!hasUnsavedFiles()) return;
    event.preventDefault();
    Object.assign(event, { returnValue: '' });
  };
  target.addEventListener('beforeunload', beforeUnload);
  return () => target.removeEventListener('beforeunload', beforeUnload);
}
