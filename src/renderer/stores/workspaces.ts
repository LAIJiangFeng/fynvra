import { errorMessage } from '@shared/guards';
import type { WorkspaceSummary } from '@shared/types/workspace';
import { create } from 'zustand';
import { translate } from '@/i18n';
import type { OpenWithTarget, WorkspaceCopyKind } from '../../preload/domains/workspaces';

/** 需要用户确认的提示（如挂入被拒绝的原因），由 NoticeDialog 展示。 */
export interface Notice {
  title: string;
  message: string;
}

export interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  selectedId: string | null;
  /** 选中工作区下面的会话列表折叠着（只在内存里，不落盘）；换选工作区时展开 */
  sessionsCollapsed: boolean;
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
  /** 折叠 / 展开选中工作区的会话列表（点已选中的工作区） */
  toggleSessions(): void;
  /** 展开选中工作区的会话列表（快捷键要用列表里的按钮时） */
  expandSessions(): void;
  dismissNotice(): void;
}

const api = window.fynvra.workspaces;

export const useWorkspacesStore = create<WorkspacesState>()((set, get) => ({
  workspaces: [],
  selectedId: null,
  sessionsCollapsed: false,
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
      set((state) => ({
        workspaces: result.workspaces,
        selectedId: result.workspaces.some((workspace) => workspace.id === state.selectedId)
          ? state.selectedId
          : null,
      }));
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
        set({ selectedId: result.workspace.id, sessionsCollapsed: false });
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

  select: (selectedId) => set({ selectedId, sessionsCollapsed: false }),
  toggleSessions: () => set((state) => ({ sessionsCollapsed: !state.sessionsCollapsed })),
  expandSessions: () => set({ sessionsCollapsed: false }),
  dismissNotice: () => set({ notice: null }),
}));

export const selectSelectedWorkspace = (state: WorkspacesState): WorkspaceSummary | undefined =>
  state.workspaces.find((workspace) => workspace.id === state.selectedId);

// 其他窗口挂入 / 移除后同步列表
api.onChanged(() => {
  void useWorkspacesStore.getState().refresh();
});
void useWorkspacesStore.getState().refresh();
