import { errorMessage } from '@shared/guards';
import type {
  ApprovalDecision,
  ApprovalRequest,
  SessionEventEnvelope,
  SessionSummary,
} from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { create, type StoreApi } from 'zustand';
import type { SessionsApi } from '../../lib/api/sessions';
import {
  addOptimisticMessage,
  applyHistory,
  type ChatProjection,
  dequeueApproval,
  emptyProjection,
  enqueueApproval,
  type PendingApproval,
  reduceSessionEvent,
  syncSessionStatuses,
  withdrawOptimisticMessage,
} from './reducer';
import { isBusy, statusOf } from './selectors';

export interface SessionsState extends ChatProjection {
  /** 侧栏选中的工作区；新建会话建在这里 */
  workspaceId: string | null;
  /** 按工作区缓存的会话列表，最近更新的在前 */
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  activeSessionId: string | null;
  /** 输入框草稿，按会话保存 */
  drafts: Record<string, string>;
  /** 正在拉 history 的会话 */
  loadingHistory: Record<string, true>;
  /** 拉列表失败的工作区 → 错误信息 */
  listErrors: Record<string, string>;
  /** 聊天区要提示的操作失败（读记录、停止、审批答复），用户关掉后清除 */
  notice: string | null;

  /** 切换工作区：拉它的会话列表；选中的会话不属于它时取消选中 */
  setWorkspace(workspaceId: string | null): void;
  loadSessions(workspaceId: string): Promise<void>;
  /** 在当前工作区用指定角色新建会话并选中它 */
  createSession(roleId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 选中会话并拉 history（权威投影）替换本地正文 */
  selectSession(sessionId: string | null): Promise<void>;
  /** 向选中的会话发送；空文本、会话运行中或上一条还在途时返回 false */
  send(text: string): Promise<boolean>;
  abort(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  setDraft(sessionId: string, text: string): void;
  dismissNotice(): void;
  /** Main 推送的会话事件：攒批后经 reducer 归并 */
  receiveEvent(envelope: SessionEventEnvelope): void;
  /** Main 推送的审批请求 */
  receiveApproval(request: ApprovalRequest): void;
}

export interface SessionsStoreOptions {
  /** 事件归并的调度：默认攒 16ms 一批；测试可注入同步调度 */
  schedule?: (flush: () => void) => void;
  now?: () => number;
}

const EVENT_BATCH_MS = 16;

async function safely<T extends object>(call: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

const byRecent = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

/** 去掉开头的空行与末尾空白，保留首行缩进（可能是代码） */
function normalizePrompt(text: string): string {
  return text.replace(/^\s*\n/, '').trimEnd();
}

/**
 * 会话 store：列表、选中、草稿与正文投影。不读全局 window，便于在 node 环境注入假 API 测试；
 * 应用内实例见 ./index。推送要经 {@link connectSessionsStore} 接上。
 */
export function createSessionsStore(api: SessionsApi, options: SessionsStoreOptions = {}) {
  const schedule =
    options.schedule ??
    ((flush: () => void) => {
      setTimeout(flush, EVENT_BATCH_MS);
    });
  const now = options.now ?? Date.now;
  let pending: SessionEventEnvelope[] = [];
  let scheduled = false;
  let localSeq = 0;
  /** prompt 调用还在途的会话：列表刷新不覆盖它们的乐观 running */
  const sending = new Set<string>();
  /** 每个工作区 / 会话最近一次请求的序号：回包晚于更新的请求时丢弃 */
  const listRequests = new Map<string, number>();
  const historyRequests = new Map<string, number>();
  let requestSeq = 0;

  return create<SessionsState>()((set, get) => {
    function flushEvents(): void {
      scheduled = false;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      set((state) => {
        let next = state;
        for (const envelope of batch) next = reduceSessionEvent(next, envelope, now());
        return next;
      });
    }

    function findApproval(requestId: string): PendingApproval | undefined {
      for (const queue of Object.values(get().pendingApprovals)) {
        const found = queue.find((request) => request.id === requestId);
        if (found) return found;
      }
      return undefined;
    }

    return {
      ...emptyProjection(),
      workspaceId: null,
      sessionsByWorkspace: {},
      activeSessionId: null,
      drafts: {},
      loadingHistory: {},
      listErrors: {},
      notice: null,

      setWorkspace(workspaceId) {
        const state = get();
        if (state.workspaceId === workspaceId) return;
        const active = state.activeSessionId;
        const keep =
          active !== null &&
          workspaceId !== null &&
          (state.sessionsByWorkspace[workspaceId] ?? []).some((session) => session.id === active);
        set({ workspaceId, activeSessionId: keep ? active : null });
        if (workspaceId) void get().loadSessions(workspaceId);
      },

      async loadSessions(workspaceId) {
        const request = ++requestSeq;
        listRequests.set(workspaceId, request);
        const result = await safely(() => api.list(workspaceId));
        if (listRequests.get(workspaceId) !== request) return;
        if (!result.ok) {
          set((state) => ({ listErrors: { ...state.listErrors, [workspaceId]: result.error } }));
          return;
        }
        const sessions = [...result.sessions].sort(byRecent);
        set((state) => {
          const active = state.activeSessionId;
          const removed =
            active !== null &&
            (state.sessionsByWorkspace[workspaceId] ?? []).some(
              (session) => session.id === active
            ) &&
            !sessions.some((session) => session.id === active);
          return {
            ...syncSessionStatuses(state, sessions, sending),
            sessionsByWorkspace: { ...state.sessionsByWorkspace, [workspaceId]: sessions },
            listErrors: omitKey(state.listErrors, workspaceId),
            ...(removed ? { activeSessionId: null } : {}),
          };
        });
      },

      async createSession(roleId) {
        const workspaceId = get().workspaceId;
        if (!workspaceId) return { ok: false, error: '请先选择一个工作区' };
        const result = await safely(() => api.create({ workspaceId, roleId }));
        if (!result.ok) return result;
        const { session } = result;
        set((state) => {
          const list = state.sessionsByWorkspace[session.workspaceId] ?? [];
          return {
            sessionsByWorkspace: {
              ...state.sessionsByWorkspace,
              [session.workspaceId]: [session, ...list.filter((item) => item.id !== session.id)],
            },
          };
        });
        // 比创建更早发出的列表请求可能还没回包：再拉一次，旧回包会被丢弃
        void get().loadSessions(session.workspaceId);
        void get().selectSession(session.id);
        return result;
      },

      async selectSession(sessionId) {
        set({ activeSessionId: sessionId });
        if (!sessionId) return;
        const request = ++requestSeq;
        historyRequests.set(sessionId, request);
        set((state) => ({ loadingHistory: { ...state.loadingHistory, [sessionId]: true } }));
        const result = await safely(() => api.history(sessionId));
        if (historyRequests.get(sessionId) !== request) return;
        // 先归并已到达的事件，再用快照替换，免得旧事件落在快照之后
        flushEvents();
        set((state) => {
          const loadingHistory = omitKey(state.loadingHistory, sessionId);
          if (!result.ok) {
            return { loadingHistory, notice: `读取会话记录失败：${result.error}` };
          }
          return { ...applyHistory(state, sessionId, result.messages), loadingHistory };
        });
      },

      async send(text) {
        const sessionId = get().activeSessionId;
        const body = normalizePrompt(text);
        if (!sessionId || !body.trim()) return false;
        const previous = statusOf(get(), sessionId);
        if (sending.has(sessionId) || isBusy(previous)) return false;

        sending.add(sessionId);
        const id = `local-${++localSeq}`;
        set((state) => ({
          ...addOptimisticMessage(state, sessionId, { id, text: body, createdAt: now() }),
          drafts: omitKey(state.drafts, sessionId),
        }));
        try {
          const result = await safely(() => api.prompt({ sessionId, text: body }));
          if (result.ok) return true;
          set((state) => ({
            ...withdrawOptimisticMessage(state, sessionId, id, {
              status: previous,
              error: result.error,
            }),
            // 没送出去的文字放回输入框（用户已经开始写新草稿时不覆盖）
            drafts: state.drafts[sessionId] ? state.drafts : { ...state.drafts, [sessionId]: text },
          }));
          return false;
        } finally {
          sending.delete(sessionId);
        }
      },

      async abort() {
        const sessionId = get().activeSessionId;
        if (!sessionId) return;
        const result = await safely(() => api.abort(sessionId));
        if (!result.ok) set({ notice: `停止失败：${result.error}` });
      },

      async respondApproval(requestId, decision) {
        const request = findApproval(requestId);
        if (!request) return;
        const { sessionId } = request;
        set((state) => dequeueApproval(state, sessionId, requestId));
        const result = await safely(() => api.respondApproval({ sessionId, requestId, decision }));
        if (result.ok) return;
        set((state) =>
          // 会话已经结束（审批随之作废）就不再放回队列
          isBusy(statusOf(state, sessionId))
            ? { ...enqueueApproval(state, request), notice: `审批答复没有送达：${result.error}` }
            : { notice: `审批答复没有送达：${result.error}` }
        );
      },

      setDraft(sessionId, text) {
        set((state) => ({
          drafts: text ? { ...state.drafts, [sessionId]: text } : omitKey(state.drafts, sessionId),
        }));
      },

      dismissNotice() {
        set({ notice: null });
      },

      receiveEvent(envelope) {
        pending.push(envelope);
        if (scheduled) return;
        scheduled = true;
        schedule(flushEvents);
      },

      receiveApproval(request) {
        flushEvents();
        set((state) => enqueueApproval(state, request));
      },
    };
  });
}

/** 接上 Main 的三路推送；返回取消订阅。 */
export function connectSessionsStore(
  store: Pick<StoreApi<SessionsState>, 'getState'>,
  api: SessionsApi
): () => void {
  const unsubscribes = [
    api.onEvent((envelope) => store.getState().receiveEvent(envelope)),
    api.onApprovalRequest((request) => store.getState().receiveApproval(request)),
    api.onSessionsChanged((workspaceId) => {
      const state = store.getState();
      // 只刷新看过的工作区；其余的等切过去时再拉
      if (
        workspaceId === state.workspaceId ||
        Object.hasOwn(state.sessionsByWorkspace, workspaceId)
      ) {
        void state.loadSessions(workspaceId);
      }
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
