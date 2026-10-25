import { useSettingsViewStore } from '@/components/settings/settingsViewStore';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useActionHandler } from './handlers';
import { cycleSessionId, filterSessionsByTitle, useSessionSearchStore } from './sessionFilter';
import { useKeybindings } from './useKeybindings';

/** 上一个 / 下一个会话：按当前工作区侧栏里的顺序；搜索框过滤着时只在结果里走 */
function cycleSession(direction: 1 | -1): void {
  const { workspaceId, sessionsByWorkspace, activeSessionId, selectSession } =
    useSessionsStore.getState();
  if (!workspaceId) return;
  const shown = filterSessionsByTitle(
    sessionsByWorkspace[workspaceId] ?? [],
    useSessionSearchStore.getState().query
  );
  const next = cycleSessionId(
    shown.map((session) => session.id),
    activeSessionId,
    direction
  );
  if (next && next !== activeSessionId) void selectSession(next);
}

/**
 * 全局快捷键：在窗口上监听按键、按动作表派发，在 App 里挂一次。
 * 打开设置、切换右侧面板、上一个 / 下一个会话在这里处理；新建会话、聚焦输入框、搜索会话
 * 由负责的组件经 useActionHandler 登记，它们不在界面上时这些键不拦截。
 */
export function KeybindingProvider() {
  useKeybindings();
  useActionHandler('open-settings', () => useSettingsViewStore.getState().show());
  useActionHandler('toggle-side-panel', () => useSettingsStore.getState().toggleSidePanel());
  useActionHandler('prev-session', () => cycleSession(-1));
  useActionHandler('next-session', () => cycleSession(1));
  return null;
}
