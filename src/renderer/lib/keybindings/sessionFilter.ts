import { create } from 'zustand';

/** 按标题过滤（包含即可，不分大小写，去掉首尾空白）；空查询返回原数组 */
export function filterSessionsByTitle<T extends { title: string }>(
  sessions: T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => session.title.toLowerCase().includes(needle));
}

/**
 * 上一个 / 下一个会话：在列表里往前或往后走一个，首尾相接。
 * 没选中（或选中的被过滤掉了）时往后取第一个、往前取最后一个；列表为空时为 null。
 */
export function cycleSessionId(
  ids: readonly string[],
  activeId: string | null,
  direction: 1 | -1
): string | null {
  if (ids.length === 0) return null;
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  if (index === -1) return (direction === 1 ? ids[0] : ids.at(-1)) ?? null;
  return ids[(index + direction + ids.length) % ids.length] ?? null;
}

interface WorkspaceSearch {
  open: boolean;
  query: string;
  /** 每次「搜索会话」加一：搜索框据此重新聚焦并全选 */
  focusRequest: number;
}

const EMPTY_SEARCH: WorkspaceSearch = { open: false, query: '', focusRequest: 0 };

interface SessionSearchState {
  byWorkspace: Record<string, WorkspaceSearch>;
  show(workspaceId: string): void;
  setQuery(workspaceId: string, query: string): void;
  /** 收起并清空该工作区的搜索 */
  close(workspaceId: string): void;
}

export const searchOf = (state: SessionSearchState, workspaceId: string): WorkspaceSearch =>
  state.byWorkspace[workspaceId] ?? EMPTY_SEARCH;

/** 每个工作区独立的会话搜索：纯界面状态，不持久化 */
export const useSessionSearchStore = create<SessionSearchState>()((set) => {
  const update = (
    workspaceId: string,
    change: (search: WorkspaceSearch) => Partial<WorkspaceSearch>
  ) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: { ...searchOf(state, workspaceId), ...change(searchOf(state, workspaceId)) },
      },
    }));
  return {
    byWorkspace: {},
    show: (workspaceId) =>
      update(workspaceId, (search) => ({
        open: true,
        focusRequest: search.focusRequest + 1,
      })),
    setQuery: (workspaceId, query) => update(workspaceId, () => ({ query })),
    close: (workspaceId) => update(workspaceId, () => ({ open: false, query: '' })),
  };
});
