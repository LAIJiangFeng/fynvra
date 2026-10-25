import type { ModelProviderOption, SessionStatus, SessionSummary } from '@shared/types/chat';
import type { SessionsState } from './createSessionsStore';
import type { PendingApproval, SessionRuntime, TimelineMessage } from './reducer';

// 选择器返回 store 里已有的引用；缺省值用模块级常量，避免每次渲染都拿到新对象
const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_MESSAGES: TimelineMessage[] = [];
const EMPTY_APPROVALS: PendingApproval[] = [];
const EMPTY_PROVIDERS: ModelProviderOption[] = [];

type Lists = Pick<SessionsState, 'sessionsByWorkspace'>;

export function findSession(state: Lists, sessionId: string): SessionSummary | undefined {
  for (const sessions of Object.values(state.sessionsByWorkspace)) {
    const found = sessions.find((session) => session.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

/** 会话当前状态：有事件投影时以投影为准，否则取列表里 Main 给的状态。 */
export function statusOf(
  state: Lists & Pick<SessionsState, 'runtimeBySession'>,
  sessionId: string
): SessionStatus {
  return (
    state.runtimeBySession[sessionId]?.status ?? findSession(state, sessionId)?.status ?? 'idle'
  );
}

/** 运行中（含等待审批）：不能再发新消息。 */
export const isBusy = (status: SessionStatus): boolean =>
  status === 'running' || status === 'waiting-approval';

export const selectWorkspaceId = (state: SessionsState) => state.workspaceId;
export const selectActiveSessionId = (state: SessionsState) => state.activeSessionId;
export const selectNotice = (state: SessionsState) => state.notice;
/** 可选的服务与模型；还没读到时为空列表 */
export const selectModelProviders = (state: SessionsState): ModelProviderOption[] =>
  state.modelProviders ?? EMPTY_PROVIDERS;

/** 工作区的全部会话（含归档的），最近更新的在前 */
export const selectSessionsOf =
  (workspaceId: string) =>
  (state: SessionsState): SessionSummary[] =>
    state.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS;

interface SessionGroups {
  active: SessionSummary[];
  /** 最近归档的在前 */
  archived: SessionSummary[];
}

// 按列表引用缓存分组：同一份列表总拿到同一对数组，订阅它的组件不会因为新数组反复渲染
const groupsByList = new WeakMap<SessionSummary[], SessionGroups>();

function groupsOf(sessions: SessionSummary[]): SessionGroups {
  let groups = groupsByList.get(sessions);
  if (!groups) {
    const archived = sessions.filter((session) => session.archivedAt !== undefined);
    groups = {
      active: sessions.filter((session) => session.archivedAt === undefined),
      archived: archived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    };
    groupsByList.set(sessions, groups);
  }
  return groups;
}

/** 侧栏的会话：没归档的，最近更新的在前 */
export const selectActiveSessionsOf = (workspaceId: string) => (state: SessionsState) =>
  groupsOf(selectSessionsOf(workspaceId)(state)).active;

/** 侧栏底部「已归档」分组：最近归档的在前 */
export const selectArchivedSessionsOf = (workspaceId: string) => (state: SessionsState) =>
  groupsOf(selectSessionsOf(workspaceId)(state)).archived;

export const selectListErrorOf = (workspaceId: string) => (state: SessionsState) =>
  state.listErrors[workspaceId];

export const selectSessionOf = (sessionId: string) => (state: SessionsState) =>
  findSession(state, sessionId);

export const selectMessagesOf =
  (sessionId: string) =>
  (state: SessionsState): TimelineMessage[] =>
    state.messagesBySession[sessionId] ?? EMPTY_MESSAGES;

export const selectApprovalsOf =
  (sessionId: string) =>
  (state: SessionsState): PendingApproval[] =>
    state.pendingApprovals[sessionId] ?? EMPTY_APPROVALS;

export const selectStatusOf = (sessionId: string) => (state: SessionsState) =>
  statusOf(state, sessionId);

export const selectRuntimeOf =
  (sessionId: string) =>
  (state: SessionsState): SessionRuntime | undefined =>
    state.runtimeBySession[sessionId];

export const selectDraftOf = (sessionId: string) => (state: SessionsState) =>
  state.drafts[sessionId] ?? '';

export const selectLoadingHistoryOf = (sessionId: string) => (state: SessionsState) =>
  state.loadingHistory[sessionId] === true;
