import { errorMessage } from '@shared/guards';
import type { WorkspaceSummary } from '@shared/types/workspace';
import { create } from 'zustand';
import { translate } from '@/i18n';

/** 需要用户确认的提示（如挂入被拒绝的原因），由 NoticeDialog 展示。 */
export interface Notice {
  title: string;
  message: string;
}

export interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  selectedId: string | null;
  adding: boolean;
  notice: Notice | null;
  refresh(): Promise<void>;
  /** Main 弹出目录选择框；挂入成功后选中该工作区 */
  add(): Promise<void>;
  remove(id: string): Promise<void>;
  select(id: string): void;
  dismissNotice(): void;
}

const api = window.fynvra.workspaces;

export const useWorkspacesStore = create<WorkspacesState>()((set, get) => ({
  workspaces: [],
  selectedId: null,
  adding: false,
  notice: null,

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
        set({ selectedId: result.workspace.id });
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

  select: (selectedId) => set({ selectedId }),
  dismissNotice: () => set({ notice: null }),
}));

export const selectSelectedWorkspace = (state: WorkspacesState): WorkspaceSummary | undefined =>
  state.workspaces.find((workspace) => workspace.id === state.selectedId);

// 其他窗口挂入 / 移除后同步列表
api.onChanged(() => {
  void useWorkspacesStore.getState().refresh();
});
void useWorkspacesStore.getState().refresh();
