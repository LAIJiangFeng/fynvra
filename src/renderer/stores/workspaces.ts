import { errorMessage } from '@shared/guards';
import type { WorkspaceSummary } from '@shared/types/workspace';
import { create } from 'zustand';
import type { OpenWithTarget, WorkspaceCopyKind } from '../../preload/domains/workspaces';
import { translate } from '../i18n';
import { filesStoreFor } from './files';
import { forgetWorkspaceTabs } from './workspaceTabs';

/** 需要用户确认的提示（如挂入被拒绝的原因），由 NoticeDialog 展示。 */
export interface Notice {
  title: string;
  message: string;
}

export interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  selectedId: string | null;
  /** 各工作区的会话列表是否展开，只在内存里保存 */
  expandedWorkspaces: Record<string, boolean>;
  adding: boolean;
  notice: Notice | null;
  openWithTargets: OpenWithTarget[];
  loadOpenWithApps(refresh?: boolean): Promise<void>;
  openIn(workspaceId: string, appId: string): Promise<void>;
  copy(workspaceId: string, what: WorkspaceCopyKind): Promise<void>;
  refresh(): Promise<void>;
  /** Main 弹出目录选择框；挂入成功后选中该工作区（展开它的会话列表） */
  add(): Promise<void>;
  remove(id: string): Promise<void>;
  /** 选中工作区并展开它的会话列表 */
  select(id: string): void;
  /** 独立折叠 / 展开工作区的会话列表，不改变选中 */
  toggleSessions(workspaceId: string): void;
  /** 展开选中工作区的会话列表（快捷键要用列表里的按钮时） */
  expandSessions(): void;
  dismissNotice(): void;
}

const api = window.fynvra.workspaces;
let selectionVersion = 0;
let restoredSelection = false;

export const useWorkspacesStore = create<WorkspacesState>()((set, get) => ({
  workspaces: [],
  selectedId: null,
  expandedWorkspaces: {},
  adding: false,
  notice: null,
  openWithTargets: [],

  async loadOpenWithApps(refresh = false) {
    try {
      const result = await api.openWithApps({ refresh });
      if (result.ok) set({ openWithTargets: result.apps });
      else set({ notice: { title: translate('workspaces.actionFailed'), message: result.error } });
    } catch (error) {
      set({
        notice: { title: translate('workspaces.actionFailed'), message: errorMessage(error) },
      });
    }
  },

  async openIn(workspaceId, appId) {
    try {
      const result = await api.openIn({ workspaceId, appId });
      if (!result.ok)
        set({ notice: { title: translate('workspaces.actionFailed'), message: result.error } });
    } catch (error) {
      set({
        notice: { title: translate('workspaces.actionFailed'), message: errorMessage(error) },
      });
    }
  },

  async copy(workspaceId, what) {
    const title = translate(
      what === 'path'
        ? 'workspaces.copyPath'
        : what === 'name'
          ? 'workspaces.copyName'
          : 'workspaces.copyBranch'
    );
    try {
      const result = await api.copy({ workspaceId, what });
      set({
        notice: { title, message: result.ok ? translate('workspaces.copied') : result.error },
      });
    } catch (error) {
      set({ notice: { title, message: errorMessage(error) } });
    }
  },

  async refresh() {
    try {
      const result = await api.list();
      if (!result.ok) {
        set({ notice: { title: translate('workspaces.loadFailed'), message: result.error } });
        return;
      }
      for (const previous of get().workspaces) {
        if (!result.workspaces.some((workspace) => workspace.id === previous.id))
          forgetWorkspaceTabs(previous.id);
      }
      set((state) => ({
        workspaces: result.workspaces,
        expandedWorkspaces: Object.fromEntries(
          result.workspaces
            .filter(
              (workspace) =>
                Object.hasOwn(state.expandedWorkspaces, workspace.id) ||
                workspace.id === state.selectedId
            )
            .map((workspace) => [workspace.id, state.expandedWorkspaces[workspace.id] ?? true])
        ),
        selectedId: result.workspaces.some((workspace) => workspace.id === state.selectedId)
          ? state.selectedId
          : null,
      }));
      if (!restoredSelection) {
        restoredSelection = true;
        const version = selectionVersion;
        const restored = await window.fynvra.workspaceUi.selection();
        if (
          restored.ok &&
          restored.workspaceId &&
          version === selectionVersion &&
          !get().selectedId &&
          get().workspaces.some((workspace) => workspace.id === restored.workspaceId)
        )
          get().select(restored.workspaceId);
      }
    } catch (error) {
      set({ notice: { title: translate('workspaces.loadFailed'), message: errorMessage(error) } });
    }
  },

  async add() {
    if (get().adding) return;
    set({ adding: true });
    try {
      const result = await api.add();
      if (result.ok) {
        await get().refresh();
        get().select(result.workspace.id);
      } else if (result.code !== 'canceled') {
        set({ notice: { title: translate('workspaces.addFailed'), message: result.error } });
      }
    } catch (error) {
      set({ notice: { title: translate('workspaces.addFailed'), message: errorMessage(error) } });
    } finally {
      set({ adding: false });
    }
  },

  async remove(id) {
    const previews = Object.values(filesStoreFor(id, window.fynvra.files).getState().previews);
    if (previews.some((preview) => preview.saving)) {
      set({
        notice: { title: translate('workspaces.removeFailed'), message: translate('files.saving') },
      });
      return;
    }
    // Include snapshots of workspaces that have not been hydrated in this run.
    if (!window.confirm(translate('workspaceTabs.removeDrafts'))) return;
    try {
      const result = await api.remove(id);
      if (!result.ok) {
        set({ notice: { title: translate('workspaces.removeFailed'), message: result.error } });
        return;
      }
      await get().refresh();
    } catch (error) {
      set({
        notice: { title: translate('workspaces.removeFailed'), message: errorMessage(error) },
      });
    }
  },

  select: (selectedId) => {
    selectionVersion++;
    set((state) => ({
      selectedId,
      expandedWorkspaces: { ...state.expandedWorkspaces, [selectedId]: true },
    }));
    void window.fynvra.workspaceUi
      .selection(selectedId)
      .then((result) => {
        if (!result.ok)
          set({ notice: { title: translate('workspaceTabs.failed'), message: result.error } });
      })
      .catch(() =>
        set({
          notice: {
            title: translate('workspaceTabs.failed'),
            message: translate('workspaceTabs.failed'),
          },
        })
      );
  },
  toggleSessions: (workspaceId) =>
    set((state) => ({
      expandedWorkspaces: {
        ...state.expandedWorkspaces,
        [workspaceId]: !state.expandedWorkspaces[workspaceId],
      },
    })),
  expandSessions: () => {
    const { selectedId } = get();
    if (selectedId) get().select(selectedId);
  },
  dismissNotice: () => set({ notice: null }),
}));

export const selectSelectedWorkspace = (state: WorkspacesState): WorkspaceSummary | undefined =>
  state.workspaces.find((workspace) => workspace.id === state.selectedId);

// 其他窗口挂入 / 移除后同步列表
api.onChanged(() => {
  void useWorkspacesStore.getState().refresh();
});
void useWorkspacesStore.getState().refresh();
