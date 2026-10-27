import { useSettingsViewStore } from '../../components/settings/settingsViewStore';
import { getSessionsApi } from '../../lib/api/sessions';
import { diffTabsStoreFor } from '../diffTabs';
import { filesStoreFor } from '../files';
import { useTerminalsStore } from '../terminals';
import { useWorkspacesStore } from '../workspaces';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';

export type { ImageRejection, QueuedMessage, SessionsState } from './createSessionsStore';
export type { PendingApproval, SessionRuntime, TimelineMessage, UsageTotals } from './reducer';
export * from './selectors';

// RENDERER_VITE_SESSIONS_MOCK=1 pnpm dev：不接 Main，用内存 mock 演示会话（无需模型 key）
const api = getSessionsApi({ mock: import.meta.env.RENDERER_VITE_SESSIONS_MOCK === '1' });

/** 会话列表、选中、草稿与正文投影；Main 的推送经 reducer 归并。按字段订阅。 */
export const useSessionsStore = createSessionsStore(api, {
  onSelectSession(workspaceId) {
    useWorkspacesStore.getState().select(workspaceId);
    useTerminalsStore.getState().select(workspaceId, null);
    filesStoreFor(workspaceId, window.fynvra.files).getState().showChat();
  },
});

connectSessionsStore(useSessionsStore, api);

/** 同步读取最新选择，不让延后的 React effect 用旧工作区覆盖刚点的会话。 */
export function connectSessionsWorkspace(): () => void {
  const sync = () => {
    useSessionsStore.getState().setWorkspace(useWorkspacesStore.getState().selectedId);
  };
  const unsubscribe = useWorkspacesStore.subscribe(sync);
  sync();
  return unsubscribe;
}

// --- notifications ---
// 点了桌面通知：通过与侧栏相同的选择入口同步会话、工作区及文件视图
window.fynvra.notifications.onFocusSession(({ workspaceId, sessionId }) => {
  useSettingsViewStore.getState().close();
  void useSessionsStore.getState().selectSession(sessionId, workspaceId);
});

// 屏幕上正看着的聊天报给 Main；设置、文件、差异或终端盖住时为 null。
// 启动时先报一次：页面重新加载后，Main 记着的还是加载前看的那个会话
let viewing: string | null | undefined;
let watchedWorkspace: string | null | undefined;
let unwatchViews: (() => void) | undefined;
function reportViewing(): void {
  const workspaceId = useWorkspacesStore.getState().selectedId;
  const files = workspaceId ? filesStoreFor(workspaceId, window.fynvra.files) : undefined;
  const diffs = workspaceId ? diffTabsStoreFor(workspaceId) : undefined;
  if (watchedWorkspace !== workspaceId) {
    unwatchViews?.();
    watchedWorkspace = workspaceId;
    const unsubscribes = workspaceId
      ? [
          files?.subscribe(reportViewing),
          diffs?.subscribe(reportViewing),
          useTerminalsStore.subscribe((state, previous) => {
            if (state.selected[workspaceId] !== previous.selected[workspaceId]) reportViewing();
          }),
        ]
      : [];
    unwatchViews = () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.();
    };
  }
  const sessions = useSessionsStore.getState();
  const next =
    !workspaceId ||
    sessions.workspaceId !== workspaceId ||
    useSettingsViewStore.getState().open ||
    files?.getState().selectedId ||
    diffs?.getState().selectedId ||
    useTerminalsStore.getState().selected[workspaceId]
      ? null
      : sessions.activeSessionId;
  if (next === viewing) return;
  viewing = next;
  void window.fynvra.notifications.setViewing(next);
}
reportViewing();
useSessionsStore.subscribe(reportViewing);
useSettingsViewStore.subscribe(reportViewing);
useWorkspacesStore.subscribe(reportViewing);
