import { useSettingsViewStore } from '@/components/settings/settingsViewStore';
import { getSessionsApi } from '@/lib/api/sessions';
import { useWorkspacesStore } from '../workspaces';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';

export type { SessionsState } from './createSessionsStore';
export type { PendingApproval, SessionRuntime, TimelineMessage, UsageTotals } from './reducer';
export * from './selectors';

// RENDERER_VITE_SESSIONS_MOCK=1 pnpm dev：不接 Main，用内存 mock 演示会话（无需模型 key）
const api = getSessionsApi({ mock: import.meta.env.RENDERER_VITE_SESSIONS_MOCK === '1' });

/** 会话列表、选中、草稿与正文投影；Main 的推送经 reducer 归并。按字段订阅。 */
export const useSessionsStore = createSessionsStore(api);

connectSessionsStore(useSessionsStore, api);

// --- notifications ---
// 点了桌面通知：切到会话所在的工作区再选中它（先切会话 store：侧栏随后同步到同一个工作区，不会清掉选中）
window.fynvra.notifications.onFocusSession(({ workspaceId, sessionId }) => {
  useSessionsStore.getState().setWorkspace(workspaceId);
  useWorkspacesStore.getState().select(workspaceId);
  useSettingsViewStore.getState().close();
  void useSessionsStore.getState().selectSession(sessionId);
});

// 屏幕上正看着的会话报给 Main（设置视图盖住时为 null）：窗口聚焦时不弹它的通知
let viewing: string | null = null;
function reportViewing(): void {
  const next = useSettingsViewStore.getState().open
    ? null
    : useSessionsStore.getState().activeSessionId;
  if (next === viewing) return;
  viewing = next;
  void window.fynvra.notifications.setViewing(next);
}
useSessionsStore.subscribe(reportViewing);
useSettingsViewStore.subscribe(reportViewing);
