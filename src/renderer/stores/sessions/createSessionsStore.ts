import type { ApprovalMode } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ModelProviderOption,
  SessionEventEnvelope,
  SessionModelRef,
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
import { findSession, isBusy, statusOf } from './selectors';

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
  /** 聊天区要提示的操作失败（读记录、停止、审批答复、换模型），用户关掉后清除 */
  notice: string | null;
  /** sessions:model-options 的服务与模型（每个模型带它可选的思考档位）；null 表示还没读到 */
  modelProviders: ModelProviderOption[] | null;
  /** 最近一次读可选模型失败的原因 */
  modelOptionsError: string | null;
  /** 各工作区上一次用过的模型（新建会话弹层的默认值之一） */
  lastModelByWorkspace: Record<string, SessionModelRef>;
  /** 打开着模型选择器的会话：输入框胶囊与状态栏打开的是同一个 */
  modelPickerFor: string | null;

  /** 切换工作区：拉它的会话列表；选中的会话不属于它时取消选中 */
  setWorkspace(workspaceId: string | null): void;
  loadSessions(workspaceId: string): Promise<void>;
  /** 在当前工作区用指定角色（和选的模型）新建会话并选中它 */
  createSession(
    roleId: string,
    model?: SessionModelRef
  ): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 选中会话并拉 history（权威投影）替换本地正文 */
  selectSession(sessionId: string | null): Promise<void>;
  /** 向选中的会话发送；空文本、会话运行中或上一条还在途时返回 false */
  send(text: string): Promise<boolean>;
  abort(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  setDraft(sessionId: string, text: string): void;
  dismissNotice(): void;
  /** 读可选模型；传工作区时一并读它上一次用过的模型（缺省为当前工作区） */
  loadModelOptions(workspaceId?: string | null): Promise<void>;
  /**
   * 换会话的模型 / 思考档位：先在列表里换上（乐观更新），Main 回包后以它的记录为准；
   * 失败时换回原来的模型、提示原因并重拉列表。会话运行中或消息在途时直接拒绝。
   */
  setSessionModel(
    sessionId: string,
    model: SessionModelRef
  ): Promise<IpcResult<{ session: SessionSummary }>>;
  openModelPicker(sessionId: string): void;
  closeModelPicker(): void;
  /**
   * 换会话的审批档位：先在列表里换上（乐观更新），Main 回包后以它的记录为准；
   * 失败时换回原来的档位、提示原因并重拉列表。与换模型不同，运行中、等审批时也可以切。
   */
  setApprovalMode(
    sessionId: string,
    mode: ApprovalMode
  ): Promise<IpcResult<{ session: SessionSummary }>>;
  /**
   * 归档会话：先在列表里标上（乐观更新），Main 回包后以它的归档时间为准；失败时换回、提示原因并重拉列表。
   * 运行中、等审批或消息在途时直接拒绝。
   */
  archiveSession(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 恢复归档的会话：同上；恢复算一次更新，会话回到列表顶部 */
  unarchiveSession(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
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
const SWITCH_WHILE_BUSY = '会话正在运行，等本轮结束再切换模型';
const ARCHIVE_WHILE_BUSY = '会话正在运行，结束后再归档';

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

/** 把某个会话（按 id）换成 `update` 的结果；其他会话与列表顺序不变 */
function mapSession(
  lists: Record<string, SessionSummary[]>,
  sessionId: string,
  update: (session: SessionSummary) => SessionSummary
): Record<string, SessionSummary[]> {
  let changed = false;
  const next: Record<string, SessionSummary[]> = {};
  for (const [workspaceId, sessions] of Object.entries(lists)) {
    next[workspaceId] = sessions.map((session) => {
      if (session.id !== sessionId) return session;
      changed = true;
      return update(session);
    });
  }
  return changed ? next : lists;
}

function withModel(session: SessionSummary, model: SessionModelRef | undefined): SessionSummary {
  const { model: _previous, ...rest } = session;
  return model ? { ...rest, model } : rest;
}

function withArchivedAt(session: SessionSummary, archivedAt: number | undefined): SessionSummary {
  const { archivedAt: _previous, ...rest } = session;
  return archivedAt === undefined ? rest : { ...rest, archivedAt };
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
  /** 在途的换模型：列表刷新时保留乐观的模型；只认每个会话最近一次请求的回包 */
  const modelSwitches = new Map<string, { request: number; model: SessionModelRef }>();
  /** 在途的换审批档位：同上 */
  const approvalSwitches = new Map<string, { request: number; mode: ApprovalMode }>();
  let modelOptionsRequest = 0;
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

    /** 归档 / 恢复：乐观改 archivedAt，回包后取 Main 的 archivedAt 与 updatedAt（恢复会改最后更新） */
    async function setArchived(
      sessionId: string,
      archived: boolean
    ): Promise<IpcResult<{ session: SessionSummary }>> {
      const session = findSession(get(), sessionId);
      if (!session) return { ok: false, error: '会话不存在' };
      if (archived && (sending.has(sessionId) || isBusy(statusOf(get(), sessionId)))) {
        return { ok: false, error: ARCHIVE_WHILE_BUSY };
      }
      const { workspaceId, archivedAt: previous } = session;
      const mark = (archivedAt: number | undefined, updatedAt?: number) =>
        set((state) => {
          const lists = mapSession(state.sessionsByWorkspace, sessionId, (item) => ({
            ...withArchivedAt(item, archivedAt),
            updatedAt: updatedAt ?? item.updatedAt,
          }));
          const list = lists[workspaceId];
          return {
            sessionsByWorkspace: list
              ? { ...lists, [workspaceId]: [...list].sort(byRecent) }
              : lists,
          };
        });
      mark(archived ? now() : undefined);
      const result = await safely(() =>
        archived ? api.archive(sessionId) : api.unarchive(sessionId)
      );
      if (result.ok) {
        mark(result.session.archivedAt, result.session.updatedAt);
        return result;
      }
      mark(previous);
      set({ notice: `${archived ? '归档' : '恢复'}失败：${result.error}` });
      void get().loadSessions(workspaceId);
      return result;
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
      modelProviders: null,
      modelOptionsError: null,
      lastModelByWorkspace: {},
      modelPickerFor: null,

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
        // 归档的也拉：侧栏底部的「已归档」分组用
        const result = await safely(() => api.list(workspaceId, { includeArchived: true }));
        if (listRequests.get(workspaceId) !== request) return;
        if (!result.ok) {
          set((state) => ({ listErrors: { ...state.listErrors, [workspaceId]: result.error } }));
          return;
        }
        const sessions = [...result.sessions].sort(byRecent).map((session) => {
          const pending = modelSwitches.get(session.id);
          const switching = approvalSwitches.get(session.id);
          const withPendingModel = pending ? withModel(session, pending.model) : session;
          return switching
            ? { ...withPendingModel, approvalMode: switching.mode }
            : withPendingModel;
        });
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

      async createSession(roleId, model) {
        const workspaceId = get().workspaceId;
        if (!workspaceId) return { ok: false, error: '请先选择一个工作区' };
        const result = await safely(() =>
          api.create({ workspaceId, roleId, ...(model ? { model } : {}) })
        );
        if (!result.ok) return result;
        const { session } = result;
        set((state) => {
          const list = state.sessionsByWorkspace[session.workspaceId] ?? [];
          return {
            sessionsByWorkspace: {
              ...state.sessionsByWorkspace,
              [session.workspaceId]: [session, ...list.filter((item) => item.id !== session.id)],
            },
            // Main 也记下了：下次新建会话默认用它
            ...(session.model
              ? {
                  lastModelByWorkspace: {
                    ...state.lastModelByWorkspace,
                    [session.workspaceId]: session.model,
                  },
                }
              : {}),
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

      async loadModelOptions(workspaceId = get().workspaceId) {
        const request = ++modelOptionsRequest;
        const result = await safely(() => api.modelOptions(workspaceId ? { workspaceId } : {}));
        if (modelOptionsRequest !== request) return;
        if (!result.ok) {
          set({ modelOptionsError: result.error });
          return;
        }
        set((state) => {
          let lastModelByWorkspace = state.lastModelByWorkspace;
          if (workspaceId) {
            lastModelByWorkspace = result.lastUsed
              ? { ...lastModelByWorkspace, [workspaceId]: result.lastUsed }
              : omitKey(lastModelByWorkspace, workspaceId);
          }
          return {
            modelProviders: result.providers,
            modelOptionsError: null,
            lastModelByWorkspace,
          };
        });
      },

      async setSessionModel(sessionId, model) {
        const session = findSession(get(), sessionId);
        if (!session) return { ok: false, error: '会话不存在' };
        if (sending.has(sessionId) || isBusy(statusOf(get(), sessionId))) {
          return { ok: false, error: SWITCH_WHILE_BUSY };
        }
        const request = ++requestSeq;
        const previous = session.model;
        modelSwitches.set(sessionId, { request, model });
        set((state) => ({
          sessionsByWorkspace: mapSession(state.sessionsByWorkspace, sessionId, (item) =>
            withModel(item, model)
          ),
        }));
        const result = await safely(() => api.setModel({ sessionId, model }));
        // 用户连着点了几次：只认最近一次的回包，前面的结果由它覆盖
        if (modelSwitches.get(sessionId)?.request !== request) return result;
        modelSwitches.delete(sessionId);
        if (result.ok) {
          const updated = result.session;
          set((state) => ({
            sessionsByWorkspace: mapSession(state.sessionsByWorkspace, sessionId, () => updated),
            ...(updated.model && updated.dispatchId === undefined
              ? {
                  lastModelByWorkspace: {
                    ...state.lastModelByWorkspace,
                    [updated.workspaceId]: updated.model,
                  },
                }
              : {}),
          }));
          return result;
        }
        set((state) => ({
          sessionsByWorkspace: mapSession(state.sessionsByWorkspace, sessionId, (item) =>
            withModel(item, previous)
          ),
          notice: `切换模型失败：${result.error}`,
        }));
        // 换回的是发起前看到的模型；以 Main 的记录为准再拉一次
        void get().loadSessions(session.workspaceId);
        return result;
      },

      async setApprovalMode(sessionId, mode) {
        const session = findSession(get(), sessionId);
        if (!session) return { ok: false, error: '会话不存在' };
        const request = ++requestSeq;
        const previous = session.approvalMode;
        approvalSwitches.set(sessionId, { request, mode });
        const switchTo = (approvalMode: ApprovalMode) =>
          set((state) => ({
            sessionsByWorkspace: mapSession(state.sessionsByWorkspace, sessionId, (item) =>
              item.approvalMode === approvalMode ? item : { ...item, approvalMode }
            ),
          }));
        switchTo(mode);
        const result = await safely(() => api.setApprovalMode({ sessionId, mode }));
        // Shift+Tab 连着按了几下：只认最近一次的回包，前面的结果由它覆盖
        if (approvalSwitches.get(sessionId)?.request !== request) return result;
        approvalSwitches.delete(sessionId);
        if (result.ok) {
          const { approvalMode, updatedAt } = result.session;
          set((state) => ({
            sessionsByWorkspace: mapSession(state.sessionsByWorkspace, sessionId, (item) => ({
              ...item,
              approvalMode,
              updatedAt,
            })),
          }));
          return result;
        }
        switchTo(previous);
        set({ notice: `切换审批档位失败：${result.error}` });
        // 换回的是发起前看到的档位；以 Main 的记录为准再拉一次
        void get().loadSessions(session.workspaceId);
        return result;
      },

      archiveSession: (sessionId) => setArchived(sessionId, true),

      unarchiveSession: (sessionId) => setArchived(sessionId, false),

      openModelPicker(sessionId) {
        set({ modelPickerFor: sessionId });
      },

      closeModelPicker() {
        set({ modelPickerFor: null });
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
