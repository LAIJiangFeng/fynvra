import { create, type StoreApi } from 'zustand';
import type { DiffFileStatus } from '../components/orchestration/diff';
import type { FilesStore } from './files';
import { canOpenWorkspaceTab } from './workspaceTabPolicy';

export type DiffSection = 'committed' | 'uncommitted';
export type DiffSource =
  | { kind: 'session'; workspaceId: string; sessionId?: string }
  | { kind: 'dispatch'; workspaceId: string; dispatchId: string };

export function diffSourceKey(source: DiffSource): string {
  return JSON.stringify([
    source.kind,
    source.workspaceId,
    source.kind === 'session' ? (source.sessionId ?? null) : source.dispatchId,
  ]);
}

export interface DiffTab {
  id: string;
  workspaceId: string;
  source: DiffSource;
  section: DiffSection;
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
}

type DiffTabInput = Omit<DiffTab, 'id' | 'workspaceId'>;

interface DiffTabsState {
  opened: DiffTab[];
  selectedId: string | null;
  open(tab: DiffTabInput): void;
  close(id: string): void;
  select(id: string | null): void;
}

export function diffTabId(tab: Pick<DiffTab, 'source' | 'section' | 'path'>): string {
  return JSON.stringify([diffSourceKey(tab.source), tab.section, tab.path]);
}

export function createDiffTabsStore(workspaceId: string) {
  return create<DiffTabsState>()((set, get) => ({
    opened: [],
    selectedId: null,
    open(input) {
      const tab: DiffTab = { ...input, workspaceId, id: diffTabId(input) };
      if (!get().opened.some((item) => item.id === tab.id) && !canOpenWorkspaceTab(workspaceId))
        return;
      set((state) => ({
        opened: state.opened.some((item) => item.id === tab.id)
          ? state.opened.map((item) => (item.id === tab.id ? tab : item))
          : [...state.opened, tab],
        selectedId: tab.id,
      }));
    },
    close(id) {
      set((state) => {
        const index = state.opened.findIndex((tab) => tab.id === id);
        const opened = state.opened.filter((tab) => tab.id !== id);
        return {
          opened,
          selectedId:
            state.selectedId === id
              ? (opened[Math.min(index, opened.length - 1)]?.id ?? null)
              : state.selectedId,
        };
      });
    },
    select(id) {
      set((state) =>
        id === null || state.opened.some((tab) => tab.id === id) ? { selectedId: id } : state
      );
    },
  }));
}

const stores = new Map<string, ReturnType<typeof createDiffTabsStore>>();

/** 按工作区缓存；重启恢复由 workspaceTabs 协调，source 始终绑定原来源。 */
export function diffTabsStoreFor(workspaceId: string) {
  let store = stores.get(workspaceId);
  if (!store) {
    store = createDiffTabsStore(workspaceId);
    stores.set(workspaceId, store);
  }
  return store;
}

type TerminalSelection = {
  selected: Record<string, string | null>;
  select(workspaceId: string, id: string | null): void;
};

/** 中央工作区挂载期间协调选择；异步内容更新不能抢走当前标签。 */
export function bindDiffTabSelection(
  workspaceId: string,
  files: FilesStore,
  terminals: Pick<StoreApi<TerminalSelection>, 'getState' | 'subscribe'>
): () => void {
  const diffs = diffTabsStoreFor(workspaceId);
  const unsubscribe = [
    files.subscribe((state, previous) => {
      if (state.selectedId && state.selectedId !== previous.selectedId) {
        diffs.getState().select(null);
        terminals.getState().select(workspaceId, null);
      }
    }),
    terminals.subscribe((state, previous) => {
      const id = state.selected[workspaceId];
      if (id && id !== previous.selected[workspaceId]) {
        diffs.getState().select(null);
        files.setState({ selectedId: null });
      }
    }),
    diffs.subscribe((state, previous) => {
      if (state.selectedId && state.selectedId !== previous.selectedId) {
        // 仅隐藏文件；showChat 还会取消 diff 的选择。
        files.setState({ selectedId: null });
        terminals.getState().select(workspaceId, null);
      }
    }),
  ];
  return () => {
    for (const unbind of unsubscribe) unbind();
  };
}
