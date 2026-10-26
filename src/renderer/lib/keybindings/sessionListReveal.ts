import type { ActionId } from '@shared/keybindings';
import { deferAction } from './handlers';

/** 由左栏会话分组里的组件处理的动作：新建会话（NewSessionButton compact）、搜索会话（SessionSearchButton） */
export type SessionListAction = Extract<ActionId, 'new-session' | 'search-sessions'>;

/** 决定会话分组在不在界面上的布局 */
export interface SessionListLayout {
  /** 选中了工作区（它在工作区列表里）：左栏里有它的会话分组 */
  workspaceSelected: boolean;
  /** 左栏展开着 */
  sidebarOpen: boolean;
  /** 选中工作区的会话列表折叠着 */
  sessionsCollapsed: boolean;
}

/** 展开会话分组的两步，按这个顺序执行 */
export interface SessionListRevealer {
  /** 展开左栏（已经展开时什么都不做） */
  openSidebar(): void;
  /** 展开选中工作区的会话列表 */
  expandSessions(): void;
}

/**
 * 会话分组不在界面上、但展开就有：选中了工作区，左栏收起或它的会话列表折叠着。
 * 这时负责「新建会话」「搜索会话」的组件没挂载，由兜底处理函数接管；
 * 没选中工作区时展开了也没有会话分组，不接管（按键照旧不拦截）。
 */
export function sessionListHidden({
  workspaceSelected,
  sidebarOpen,
  sessionsCollapsed,
}: SessionListLayout): boolean {
  return workspaceSelected && (!sidebarOpen || sessionsCollapsed);
}

/**
 * 兜底处理：先展开左栏、再展开选中工作区的会话列表，等会话分组挂载、负责的组件登记处理函数后
 * 立即执行原来的动作（新建会话打开弹层；搜索会话显示搜索框并聚焦）。
 * 先记下动作再展开：展开的过程中就挂载、登记了也不会漏掉。
 */
export function revealSessionListThen(
  action: SessionListAction,
  revealer: SessionListRevealer
): void {
  deferAction(action);
  revealer.openSidebar();
  revealer.expandSessions();
}
