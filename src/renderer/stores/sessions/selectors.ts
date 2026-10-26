import type {
  ChatImage,
  ModelProviderOption,
  SessionStatus,
  SessionSummary,
} from '@shared/types/chat';
import type { QueuedMessage, SessionsState } from './createSessionsStore';
import type { PendingApproval, SessionRuntime, TimelineMessage } from './reducer';

// 选择器返回 store 里已有的引用；缺省值用模块级常量，避免每次渲染都拿到新对象
const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_MESSAGES: TimelineMessage[] = [];
const EMPTY_APPROVALS: PendingApproval[] = [];
const EMPTY_PROVIDERS: ModelProviderOption[] = [];
const EMPTY_IMAGES: ChatImage[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];

type Lists = Pick<SessionsState, 'sessionsByWorkspace' | 'archivedByWorkspace'>;

/** 按 id 找会话，归档的也找（打开归档的会话后照样能换模型、发消息） */
export function findSession(state: Lists, sessionId: string): SessionSummary | undefined {
  for (const lists of [state.sessionsByWorkspace, state.archivedByWorkspace]) {
    for (const sessions of Object.values(lists)) {
      const found = sessions.find((session) => session.id === sessionId);
      if (found) return found;
    }
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

/** 侧栏的会话（不含归档的），最近更新的在前 */
export const selectSessionsOf =
  (workspaceId: string) =>
  (state: SessionsState): SessionSummary[] =>
    state.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS;

/** 侧栏底部「已归档」分组，最近归档的在前 */
export const selectArchivedSessionsOf =
  (workspaceId: string) =>
  (state: SessionsState): SessionSummary[] =>
    state.archivedByWorkspace[workspaceId] ?? EMPTY_SESSIONS;

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

/** 输入框里粘贴的图片（草稿） */
export const selectDraftImagesOf =
  (sessionId: string) =>
  (state: SessionsState): ChatImage[] =>
    state.draftImages[sessionId] ?? EMPTY_IMAGES;

/** Messages queued while the session runs, oldest first */
export const selectQueueOf =
  (sessionId: string) =>
  (state: SessionsState): QueuedMessage[] =>
    state.queuedBySession[sessionId] ?? EMPTY_QUEUE;

export const selectLoadingHistoryOf = (sessionId: string) => (state: SessionsState) =>
  state.loadingHistory[sessionId] === true;
