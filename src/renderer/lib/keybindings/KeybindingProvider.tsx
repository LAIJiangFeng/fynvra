import { sidebarOpenOf } from '@shared/types/settings';
import { useSettingsViewStore } from '@/components/settings/settingsViewStore';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { selectSelectedWorkspace, useWorkspacesStore } from '@/stores/workspaces';
import { useActionHandler } from './handlers';
import { cycleSessionId, filterSessionsByTitle, useSessionSearchStore } from './sessionFilter';
import {
  revealSessionListThen,
  type SessionListRevealer,
  sessionListHidden,
} from './sessionListReveal';
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

/** 先展开左栏，再展开选中工作区的会话列表 */
const revealer: SessionListRevealer = {
  openSidebar: () => useSettingsStore.getState().openSidebar(),
  expandSessions: () => useWorkspacesStore.getState().expandSessions(),
};

/**
 * 左栏收起或选中工作区的会话列表折叠期间，负责「新建会话」「搜索会话」的组件不在界面上：
 * 这里登记兜底，先展开、等它们挂载后执行原来的动作。会话分组在界面上时仍由它们自己处理。
 */
function useSessionListFallback(): void {
  const sidebarOpen = useSettingsStore(sidebarOpenOf);
  const sessionsCollapsed = useWorkspacesStore((state) => state.sessionsCollapsed);
  const workspaceSelected = useWorkspacesStore(
    (state) => selectSelectedWorkspace(state) !== undefined
  );
  const hidden = sessionListHidden({ workspaceSelected, sidebarOpen, sessionsCollapsed });
  useActionHandler('new-session', () => revealSessionListThen('new-session', revealer), hidden);
  useActionHandler(
    'search-sessions',
    () => revealSessionListThen('search-sessions', revealer),
    hidden
  );
}

/**
 * 全局快捷键：在窗口上监听按键、按动作表派发，在 App 里挂一次。
 * 打开设置、切换左栏与右侧面板、上一个 / 下一个会话在这里处理；新建会话、聚焦输入框、搜索会话
 * 由负责的组件经 useActionHandler 登记，它们不在界面上时这些键不拦截；只是因为左栏收起或会话列表折叠
 * 而不在界面上时，新建会话、搜索会话由这里兜底（先展开再交给它们）。
 */
export function KeybindingProvider() {
  useKeybindings();
  useActionHandler('open-settings', () => useSettingsViewStore.getState().show());
  useActionHandler('toggle-side-panel', () => useSettingsStore.getState().toggleSidePanel());
  useActionHandler('toggle-sidebar', () => useSettingsStore.getState().toggleSidebar());
  useActionHandler('prev-session', () => cycleSession(-1));
  useActionHandler('next-session', () => cycleSession(1));
  useSessionListFallback();
  return null;
}
