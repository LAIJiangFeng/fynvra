import type { ApprovalMode } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  base64ByteLength,
  type ChatImage,
  isChatImageMimeType,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
  type ModelProviderOption,
  type ReplySuggestion,
  type SessionEventEnvelope,
  type SessionModelRef,
  type SessionSummary,
} from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { create, type StoreApi } from 'zustand';
import { translate } from '../../i18n';
import type { SessionsApi } from '../../lib/api/sessions';
import {
  addOptimisticMessage,
  applyContextRuntime,
  applyHistory,
  compactionActive,
  compactionNeedsRecovery,
  isContextMetadata,
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

/**
 * 粘贴的图片没加进草稿的原因：`count` 超过每条消息的张数上限，`size` 超过单张或合计的大小上限，
 * `invalid` 不是可用的图片（空的、不是 base64、格式不在白名单里）
 */
export type ImageRejection = 'count' | 'size' | 'invalid';

/**
 * A message typed while the session was running. Kept in memory only (not in the transcript, which is a
 * projection of pi's jsonl): it shows up in the timeline once it is actually sent.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  images: ChatImage[];
}

type RecallQueuedResult = 'recalled' | 'draft-exists' | 'missing';

export interface SessionsState extends ChatProjection {
  /** 侧栏选中的工作区；新建会话建在这里 */
  workspaceId: string | null;
  /** 按工作区缓存的会话列表（不含归档的），最近更新的在前 */
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  /** 按工作区缓存的归档会话（侧栏底部「已归档」分组），最近归档的在前 */
  archivedByWorkspace: Record<string, SessionSummary[]>;
  activeSessionId: string | null;
  /** 输入框草稿，按会话保存 */
  drafts: Record<string, string>;
  /** 输入框里粘贴的图片，按会话保存（与 drafts 并列，切换会话不丢） */
  draftImages: Record<string, ChatImage[]>;
  /** 刚结束一轮生成的灰字建议；只在内存，与草稿分开，切换会话 / 新轮 / 换模型时清掉 */
  replySuggestions: Record<string, ReplySuggestion>;
  /**
   * Messages queued while the session was running, oldest first. Sent one at a time as prompts when
   * the turn settles to idle; kept (not sent) after a stop or an error until explicit resume.
   */
  queuedBySession: Record<string, QueuedMessage[]>;
  /** Stopped/failed queues only continue after an explicit resume. */
  pausedQueues: Record<string, true>;
  resumeQueue(sessionId: string): void;
  recoveringCompaction: Record<string, true>;
  stopping: Record<string, true>;
  retryCompaction(sessionId: string): Promise<void>;
  /** 正在拉 history 的会话 */
  loadingHistory: Record<string, true>;
  /** 拉列表失败的工作区 → 错误信息 */
  listErrors: Record<string, string>;
  /** 会话审批卡的逐请求提交状态，失败保留请求供重试。 */
  approvalSubmissions: Record<string, { pending: boolean; error?: string }>;
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
  /** 在指定工作区（缺省当前工作区）新建；等待期间发生导航则不抢回选中 */
  createSession(
    roleId: string,
    model?: SessionModelRef,
    workspaceId?: string
  ): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 同步选中会话及所属工作区，再拉 history；未缓存的会话可显式指定工作区 */
  selectSession(sessionId: string | null, workspaceId?: string): Promise<void>;
  /**
   * 向选中的会话发送文本与它的草稿图片；只有图片也能发。没有文字也没有图片、会话运行中或上一条还在途时返回 false
   */
  send(text: string): Promise<boolean>;
  /**
   * Send a message into the running turn right away (pi steer): the queued message `queuedId`, else the
   * most recent queued one, else the draft (text and images). When the session is idle the message is
   * sent as a normal prompt. Returns false when there is nothing to send or it was not delivered
   */
  steer(sessionId: string, queuedId?: string): Promise<boolean>;
  /** Drop a queued message */
  removeQueued(sessionId: string, queuedId: string): void;
  /** Restore an unsent queued message only into an empty draft, atomically with its removal */
  recallQueued(sessionId: string, queuedId: string): RecallQueuedResult;
  abort(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  setDraft(sessionId: string, text: string): void;
  /**
   * 丢掉这个会话当前的回复建议（Esc 忽略 / → 采纳）：本轮不再出现，也不会有迟到的回包补回来。
   * 只影响灰字，不改变草稿
   */
  ignoreSuggestion(sessionId: string): void;
  /** 恢复已发送的图片或保存的草稿：原样替换，不重新检查上限 */
  setDraftImages(sessionId: string, images: ChatImage[]): void;
  /**
   * 往会话的草稿里加粘贴的图片：按顺序收下放得下的（张数、单张、合计大小都在上限内），其余不加。
   * 返回第一张没加进去的原因；都加进去时为 undefined
   */
  attachImages(sessionId: string, images: readonly ChatImage[]): ImageRejection | undefined;
  /** 从会话的草稿里移除第 index 张图片 */
  removeDraftImage(sessionId: string, index: number): void;
  dismissNotice(): void;
  dismissWarning(sessionId: string): void;
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
  /** 从列表移除会话并清空本地投影；运行中拒绝，失败时恢复。底层记录文件保留。 */
  removeSession(sessionId: string): Promise<IpcResult>;
  /** Main 推送的会话事件：攒批后经 reducer 归并 */
  receiveEvent(envelope: SessionEventEnvelope): void;
  /** Main 推送的审批请求 */
  receiveApproval(request: ApprovalRequest): void;
}

export interface SessionsStoreOptions {
  /** 事件归并的调度：默认攒 16ms 一批；测试可注入同步调度 */
  schedule?: (flush: () => void) => void;
  now?: () => number;
  /** 同步侧栏选中与文件视图；在选中会话时调用，不在后台加载列表时调用 */
  onSelectSession?: (workspaceId: string) => void;
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

/** 建议在途期间模型是否换过：provider / model / 思考 / Fast 任一变化都算换过 */
function modelKeyOf(model: SessionModelRef | undefined): string {
  return model
    ? `${model.providerId}\u0000${model.modelId}\u0000${model.thinking ?? ''}\u0000${
        model.fastMode ? '1' : '0'
      }`
    : '';
}

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

type SessionLists = Pick<SessionsState, 'sessionsByWorkspace' | 'archivedByWorkspace'>;

/** 两份列表（会话 / 已归档）里都按 id 换掉：归档的会话打开后也能换模型、换审批档位 */
function mapLists(
  lists: SessionLists,
  sessionId: string,
  update: (session: SessionSummary) => SessionSummary
): SessionLists {
  return {
    sessionsByWorkspace: mapSession(lists.sessionsByWorkspace, sessionId, update),
    archivedByWorkspace: mapSession(lists.archivedByWorkspace, sessionId, update),
  };
}

const byArchived = (a: SessionSummary, b: SessionSummary) =>
  (b.archivedAt ?? 0) - (a.archivedAt ?? 0);

/** 一个工作区的会话按是否归档放进两份列表：没归档的最近更新在前，归档的最近归档在前 */
function placeSessions(
  lists: SessionLists,
  workspaceId: string,
  sessions: readonly SessionSummary[]
): SessionLists {
  const active = sessions.filter((session) => session.archivedAt === undefined);
  const archived = sessions.filter((session) => session.archivedAt !== undefined);
  return {
    sessionsByWorkspace: { ...lists.sessionsByWorkspace, [workspaceId]: active.sort(byRecent) },
    archivedByWorkspace: { ...lists.archivedByWorkspace, [workspaceId]: archived.sort(byArchived) },
  };
}

/** 工作区的全部会话（含归档的） */
function allSessionsOf(lists: SessionLists, workspaceId: string): SessionSummary[] {
  return [
    ...(lists.sessionsByWorkspace[workspaceId] ?? []),
    ...(lists.archivedByWorkspace[workspaceId] ?? []),
  ];
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
  /** ACKs can arrive after terminal events; keep request exclusion separate from progress UI. */
  const recoveryRequests = new Set<string>();
  /** 正在删除或已删除的会话：晚到的列表、history 与事件不能把它们放回来；失败时撤销。 */
  const removedSessions = new Set<string>();
  /** 每个工作区 / 会话最近一次请求的序号：回包晚于更新的请求时丢弃 */
  const listRequests = new Map<string, number>();
  const historyRequests = new Map<string, number>();
  /** 在途的换模型：列表刷新时保留乐观的模型；只认每个会话最近一次请求的回包 */
  const modelSwitches = new Map<string, { request: number; model: SessionModelRef }>();
  /** 在途的换审批档位：同上 */
  const approvalSwitches = new Map<string, { request: number; mode: ApprovalMode }>();
  /** 每个会话最近一次已发起建议的轮次（含空结果 / 失败）：同一轮不重复请求 */
  const suggestionTried = new Map<string, number>();
  /** 每个会话被 Esc 忽略的轮次；迟到的回包不再展示 */
  const suggestionIgnored = new Map<string, number>();
  /**
   * 每个会话的建议代数：新轮 / 换模型 / 停止 / 归档 / 删除 / 切会话都会推进。
   * 请求发起时记下代数，回包时代数不一致就不插入，即使回包时当前轮次 id 还相同。
   */
  const suggestionVersions = new Map<string, number>();
  /** 在途请求：会话 → 发起时的代数；切会话 / 新轮时据此作废未显示的回包 */
  const suggestionPending = new Map<string, number>();
  let modelOptionsRequest = 0;
  const modelOptionsByWorkspace = new Map<string | null, number>();
  // 任何后续导航 / 创建都使旧创建的自动选中失效，即使用户又切回了同一工作区
  let selectionVersion = 0;
  let requestSeq = 0;
  let queueSeq = 0;

  return create<SessionsState>()((set, get) => {
    function holdQueue(sessionId: string): void {
      set((state) => ({ pausedQueues: { ...state.pausedQueues, [sessionId]: true } }));
    }

    function releaseQueue(sessionId: string): void {
      set((state) => ({ pausedQueues: omitKey(state.pausedQueues, sessionId) }));
    }

    /** 推进这个会话的建议代数，并作废所有在途回包 */
    function bumpSuggestionVersion(sessionId: string): number {
      const version = (suggestionVersions.get(sessionId) ?? 0) + 1;
      suggestionVersions.set(sessionId, version);
      suggestionPending.delete(sessionId);
      return version;
    }

    /** 清掉一个会话的灰字与在途回包；即使灰字还没显示也会推进代数 */
    function clearSuggestion(sessionId: string): number {
      const version = bumpSuggestionVersion(sessionId);
      if (get().replySuggestions[sessionId]) {
        set((state) => ({ replySuggestions: omitKey(state.replySuggestions, sessionId) }));
      }
      return version;
    }

    /** 切会话 / 工作区 / 删除活动会话：可见的与还没显示的建议一起作废 */
    function clearAllSuggestions(): void {
      const state = get();
      const ids = new Set<string>([
        ...Object.keys(state.replySuggestions),
        ...suggestionPending.keys(),
      ]);
      if (ids.size === 0) return;
      for (const sessionId of ids) bumpSuggestionVersion(sessionId);
      if (Object.keys(state.replySuggestions).length > 0) set({ replySuggestions: {} });
    }

    /**
     * 一轮正常结束后，只有它是当前选中会话、输入框完全空闲时才请求一次建议：
     * 没有队列 / 待审批 / 图片 / 草稿，状态 idle。这里只碰回复建议，不改消息、draft 或状态；
     * 同一轮（含空结果 / 失败）不重复请求。请求前后都用代数与轮次核对，迟到的旧模型 / 旧轮回包不会插入
     */
    function maybeRequestSuggestion(sessionId: string, roundId: number): void {
      const state = get();
      if (state.activeSessionId !== sessionId || recoveryBlocked(sessionId)) return;
      const runtime = state.runtimeBySession[sessionId];
      if (runtime?.settledSeq !== roundId || (runtime.activitySeq ?? runtime.lastSeq) !== roundId)
        return;
      // 同一轮已经发起过（含结果为空 / 失败）：保留已有的（若有），不重复请求
      if (suggestionTried.get(sessionId) === roundId) return;
      if (suggestionIgnored.get(sessionId) === roundId) {
        clearSuggestion(sessionId);
        return;
      }
      // 新一轮：先作废旧轮的可见建议 / 在途回包，再检查输入框条件；本轮即使条件不满足也不再重复请求
      const version = clearSuggestion(sessionId);
      suggestionTried.set(sessionId, roundId);
      const fresh = get();
      if (statusOf(fresh, sessionId) !== 'idle') return;
      if ((fresh.queuedBySession[sessionId]?.length ?? 0) > 0) return;
      if ((fresh.pendingApprovals[sessionId]?.length ?? 0) > 0) return;
      if ((fresh.drafts[sessionId] ?? '') !== '') return;
      if ((fresh.draftImages[sessionId]?.length ?? 0) > 0) return;
      const session = findSession(fresh, sessionId);
      if (!session || session.archivedAt !== undefined) return;
      suggestionPending.set(sessionId, version);
      const model = modelKeyOf(session.model);
      const { workspaceId } = session;
      void safely(() => api.suggestReply({ sessionId, roundId })).then((result) => {
        // 代数 / 在途表不一致：期间换模型、停止、归档、删除或切过会话
        if (suggestionVersions.get(sessionId) !== version) return;
        if (suggestionPending.get(sessionId) !== version) return;
        suggestionPending.delete(sessionId);
        if (!result.ok || !result.suggestion) return;
        const suggestion = result.suggestion;
        if (suggestion.sessionId !== sessionId || suggestion.roundId !== roundId) return;
        if (!suggestion.text) return;
        if (suggestionIgnored.get(sessionId) === roundId) return;
        if (removedSessions.has(sessionId)) return;
        const current = get();
        if (current.activeSessionId !== sessionId) return;
        const currentRuntime = current.runtimeBySession[sessionId];
        if (
          currentRuntime?.settledSeq !== roundId ||
          (currentRuntime.activitySeq ?? currentRuntime.lastSeq) !== roundId
        )
          return;
        if (statusOf(current, sessionId) !== 'idle' || recoveryBlocked(sessionId)) return;
        if ((current.pendingApprovals[sessionId]?.length ?? 0) > 0) return;
        if ((current.queuedBySession[sessionId]?.length ?? 0) > 0) return;
        const currentSession = findSession(current, sessionId);
        if (!currentSession || currentSession.archivedAt !== undefined) return;
        if (currentSession.workspaceId !== workspaceId) return;
        if (modelKeyOf(currentSession.model) !== model) return;
        set((state) => ({
          replySuggestions: { ...state.replySuggestions, [sessionId]: suggestion },
        }));
      });
    }

    function flushEvents(): void {
      scheduled = false;
      if (pending.length === 0) return;
      const received = pending;
      pending = [];
      const batch: SessionEventEnvelope[] = [];
      set((state) => {
        let next = state;
        for (const envelope of received) {
          const reduced = reduceSessionEvent(next, envelope, now());
          // Stale events must not run side effects either (pause/drain/suggestions).
          if (reduced !== next) batch.push(envelope);
          next = reduced;
        }
        return next;
      });
      // 正文与执行状态变化（含等待审批）使旧建议失效；旁路通知不是新回合。
      // agent_settled 正常结束由下面的 maybeRequestSuggestion 统一处理。
      for (const { sessionId, event } of batch) {
        if (event.type === 'tool_notice' || isContextMetadata(event)) continue;
        if (event.type === 'agent_settled' && !event.aborted) continue;
        // 服务告警不改变对话轮次，保留当前输入框建议。
        if (event.type === 'warning') continue;
        clearSuggestion(sessionId);
      }
      // A settled turn drains the queue: only when it ended normally (stop / error keep it for the user)
      const settled = new Set<string>();
      const normal = new Map<string, number>();
      for (const { sessionId, event } of batch) {
        const failedMessage =
          event.type === 'message_end' &&
          event.role === 'assistant' &&
          (event.stopReason === 'error' || event.stopReason === 'aborted');
        if (
          event.type === 'error' ||
          failedMessage ||
          (event.type === 'context_runtime' && event.snapshot.recoveryRequired) ||
          get().runtimeBySession[sessionId]?.recoveryRequired
        )
          holdQueue(sessionId);
        if (
          event.type === 'compaction' &&
          compactionNeedsRecovery(
            event.state,
            get().runtimeBySession[sessionId]?.contextRuntime?.effectiveStrategy
          )
        )
          holdQueue(sessionId);
        if (
          event.type === 'agent_settled' ||
          event.type === 'error' ||
          failedMessage ||
          (event.type === 'compaction' &&
            !compactionActive(event.state) &&
            event.state.phase !== 'succeeded') ||
          (event.type === 'context_runtime' &&
            !event.snapshot.recoveryRequired &&
            event.snapshot.pendingPromptCount === 0 &&
            !compactionActive(event.snapshot.compaction))
        ) {
          set((state) => ({
            recoveringCompaction: omitKey(state.recoveringCompaction, sessionId),
          }));
        }
        // A final metadata snapshot can clear pending input *after* settled. Re-check the
        // queue there as well; stopped/failed queues are still protected by their hold.
        if (event.type === 'context_runtime' && !recoveryBlocked(sessionId)) {
          settled.add(sessionId);
          const roundId = get().runtimeBySession[sessionId]?.settledSeq;
          if (roundId !== undefined) normal.set(sessionId, roundId);
        }
        if (event.type !== 'agent_settled') continue;
        if (event.aborted) holdQueue(sessionId);
        else normal.set(sessionId, event.seq);
        settled.add(sessionId);
      }
      for (const sessionId of settled) drainQueue(sessionId);
      // 队列真的空了、状态仍 idle 才请求；drainQueue 发了下一条时这里会看到 running
      for (const [sessionId, roundId] of normal) maybeRequestSuggestion(sessionId, roundId);
    }

    function recoveryBlocked(sessionId: string): boolean {
      const runtime = get().runtimeBySession[sessionId];
      return Boolean(
        get().recoveringCompaction[sessionId] ||
          compactionActive(runtime?.compaction) ||
          runtime?.recoveryRequired ||
          runtime?.pendingPromptCount
      );
    }

    function queueOf(sessionId: string): QueuedMessage[] {
      return get().queuedBySession[sessionId] ?? [];
    }

    function setQueue(sessionId: string, update: (queue: QueuedMessage[]) => QueuedMessage[]) {
      set((state) => {
        const queue = update(state.queuedBySession[sessionId] ?? []);
        return {
          queuedBySession:
            queue.length > 0
              ? { ...state.queuedBySession, [sessionId]: queue }
              : omitKey(state.queuedBySession, sessionId),
        };
      });
    }

    /**
     * Prompt the session with an optimistic echo. On failure the echo is withdrawn with the error and
     * `restore` puts the message back where it came from (draft or queue)
     */
    async function deliver(
      sessionId: string,
      body: string,
      images: ChatImage[],
      restore: (state: SessionsState) => Partial<SessionsState>
    ): Promise<boolean> {
      const previous = statusOf(get(), sessionId);
      clearSuggestion(sessionId);
      sending.add(sessionId);
      const id = `local-${++localSeq}`;
      set((state) =>
        addOptimisticMessage(state, sessionId, { id, text: body, images, createdAt: now() })
      );
      try {
        const result = await safely(() =>
          api.prompt({ sessionId, text: body, ...(images.length > 0 ? { images } : {}) })
        );
        flushEvents();
        if (result.ok) return true;
        // A user message/history confirmation (or backend pending checkpoint) is stronger
        // evidence than a late failed ACK. Never restore and resend an accepted message.
        const current = get();
        const echo = current.messagesBySession[sessionId]?.find((message) => message.id === id);
        if (!echo?.optimistic || (current.runtimeBySession[sessionId]?.pendingPromptCount ?? 0) > 0)
          return true;
        holdQueue(sessionId);
        set((state) => ({
          ...withdrawOptimisticMessage(state, sessionId, id, {
            status: previous,
            error: result.error,
          }),
          ...restore(state),
        }));
        return false;
      } finally {
        sending.delete(sessionId);
        // settled may arrive before the prompt ACK; it could not drain while sending.
        drainQueue(sessionId);
      }
    }

    /** Send the oldest queued message when the session is idle and its queue is not paused */
    function drainQueue(sessionId: string, resume = false): void {
      if (
        get().pausedQueues[sessionId] ||
        get().stopping[sessionId] ||
        sending.has(sessionId) ||
        recoveryBlocked(sessionId)
      )
        return;
      const status = statusOf(get(), sessionId);
      if (status !== 'idle' && !(resume && status === 'error')) return;
      const [next] = queueOf(sessionId);
      if (!next) return;
      setQueue(sessionId, (queue) => queue.filter((item) => item.id !== next.id));
      void deliver(sessionId, next.text, next.images, (state) => {
        // Put it back in front and pause the queue so a broken session does not loop
        const queue = state.queuedBySession[sessionId] ?? [];
        return { queuedBySession: { ...state.queuedBySession, [sessionId]: [next, ...queue] } };
      });
    }

    function findApproval(requestId: string): PendingApproval | undefined {
      for (const queue of Object.values(get().pendingApprovals)) {
        const found = queue.find((request) => request.id === requestId);
        if (found) return found;
      }
      return undefined;
    }

    /**
     * 归档 / 恢复：乐观地把会话挪到另一份列表，回包后取 Main 的 archivedAt 与 updatedAt（恢复会改最后更新）。
     */
    async function setArchived(
      sessionId: string,
      archived: boolean
    ): Promise<IpcResult<{ session: SessionSummary }>> {
      const session = findSession(get(), sessionId);
      if (!session) return { ok: false, error: translate('sessions.errors.notFound') };
      if (archived && (sending.has(sessionId) || isBusy(statusOf(get(), sessionId)))) {
        return { ok: false, error: translate('sessions.errors.archiveWhileBusy') };
      }
      if (archived) clearSuggestion(sessionId);
      const { workspaceId, archivedAt: previous } = session;
      const mark = (archivedAt: number | undefined, updatedAt?: number) =>
        set((state) => {
          const sessions = allSessionsOf(state, workspaceId).map((item) =>
            item.id === sessionId
              ? { ...withArchivedAt(item, archivedAt), updatedAt: updatedAt ?? item.updatedAt }
              : item
          );
          return placeSessions(state, workspaceId, sessions);
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
      set({
        notice: translate(
          archived ? 'sessions.errors.archiveFailed' : 'sessions.errors.unarchiveFailed',
          { error: result.error }
        ),
      });
      void get().loadSessions(workspaceId);
      return result;
    }

    return {
      ...emptyProjection(),
      workspaceId: null,
      sessionsByWorkspace: {},
      archivedByWorkspace: {},
      activeSessionId: null,
      drafts: {},
      draftImages: {},
      replySuggestions: {},
      queuedBySession: {},
      pausedQueues: {},
      recoveringCompaction: {},
      stopping: {},
      loadingHistory: {},
      listErrors: {},
      approvalSubmissions: {},
      notice: null,
      modelProviders: null,
      modelOptionsError: null,
      lastModelByWorkspace: {},
      modelPickerFor: null,

      setWorkspace(workspaceId) {
        const state = get();
        if (state.workspaceId === workspaceId) return;
        selectionVersion++;
        const active = state.activeSessionId;
        const keep =
          active !== null &&
          workspaceId !== null &&
          allSessionsOf(state, workspaceId).some((session) => session.id === active);
        // 切工作区时活动会话被取消：旧灰字与在途回包一并作废
        if (!keep) clearAllSuggestions();
        set({ workspaceId, activeSessionId: keep ? active : null });
        if (workspaceId) void get().loadSessions(workspaceId);
      },

      async loadSessions(workspaceId) {
        const request = ++requestSeq;
        listRequests.set(workspaceId, request);
        const runtimes = get().runtimeBySession;
        // 归档的也拉：侧栏底部的「已归档」分组用
        const result = await safely(() => api.list(workspaceId, { includeArchived: true }));
        if (listRequests.get(workspaceId) !== request) return;
        if (!result.ok) {
          set((state) => ({ listErrors: { ...state.listErrors, [workspaceId]: result.error } }));
          return;
        }
        const sessions = [...result.sessions]
          .filter((session) => !removedSessions.has(session.id))
          .sort(byRecent)
          .map((session) => {
            const pending = modelSwitches.get(session.id);
            const switching = approvalSwitches.get(session.id);
            const withPendingModel = pending ? withModel(session, pending.model) : session;
            return switching
              ? { ...withPendingModel, approvalMode: switching.mode }
              : withPendingModel;
          });
        const before = get();
        const active = before.activeSessionId;
        // 选中的会话被删了才取消选中；它被归档（挪到另一份列表）时照常开着
        const removed =
          active !== null &&
          allSessionsOf(before, workspaceId).some((session) => session.id === active) &&
          !sessions.some((session) => session.id === active);
        // 列表刷新导致活动会话没了：旧灰字与在途回包一并作废
        if (removed) clearAllSuggestions();
        flushEvents();
        const synchronized = new Set<string>();
        set((state) => {
          const skip = new Set(sending);
          for (const session of sessions) {
            if (
              (state.runtimeBySession[session.id]?.lastSeq ?? 0) !==
                (runtimes[session.id]?.lastSeq ?? 0) ||
              state.runtimeBySession[session.id]?.contextSeq !== runtimes[session.id]?.contextSeq
            )
              skip.add(session.id);
          }
          let next = state;
          for (const session of sessions) {
            if (skip.has(session.id)) continue;
            const hydrated = applyContextRuntime(
              next,
              session.id,
              session.contextRuntime,
              session.contextRuntimeSeq
            );
            // A rejected snapshot must not reset progress through its associated status either.
            if (hydrated === next) skip.add(session.id);
            else synchronized.add(session.id);
            next = hydrated;
          }
          next = syncSessionStatuses(next, sessions, skip);
          return {
            ...next,
            ...placeSessions(state, workspaceId, sessions),
            listErrors: omitKey(state.listErrors, workspaceId),
            ...(removed ? { activeSessionId: null } : {}),
          };
        });
        for (const session of sessions) {
          if (get().runtimeBySession[session.id]?.recoveryRequired) holdQueue(session.id);
          if (
            synchronized.has(session.id) &&
            !recoveryRequests.has(session.id) &&
            (session.status === 'idle' || session.status === 'error')
          ) {
            set((state) => ({
              recoveringCompaction: omitKey(state.recoveringCompaction, session.id),
            }));
          }
        }
      },

      async createSession(roleId, model, workspaceId = get().workspaceId ?? undefined) {
        if (!workspaceId) return { ok: false, error: translate('sessions.errors.noWorkspace') };
        const selection = ++selectionVersion;
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
        if (selection === selectionVersion) {
          void get().selectSession(session.id, session.workspaceId);
        }
        return result;
      },

      async selectSession(sessionId, workspaceId) {
        if (sessionId && removedSessions.has(sessionId)) return;
        const state = get();
        const target = sessionId
          ? (findSession(state, sessionId)?.workspaceId ?? workspaceId ?? state.workspaceId)
          : state.workspaceId;
        selectionVersion++;
        // 切会话就丢弃旧的灰字建议与在途回包；回到同一会话也不复活
        if (state.activeSessionId !== sessionId) clearAllSuggestions();
        // 一次更新会话 store 的两个选中字段，外部同步再读时不会清掉刚选的会话
        set({ workspaceId: target, activeSessionId: sessionId });
        if (!sessionId) return;
        if (target) {
          options.onSelectSession?.(target);
          if (target !== state.workspaceId) void get().loadSessions(target);
        }
        const request = ++requestSeq;
        const snapshotRuntime = get().runtimeBySession[sessionId];
        historyRequests.set(sessionId, request);
        set((state) => ({ loadingHistory: { ...state.loadingHistory, [sessionId]: true } }));
        const result = await safely(() => api.history(sessionId));
        if (historyRequests.get(sessionId) !== request) return;
        // 先归并已到达的事件，再用快照替换，免得旧事件落在快照之后
        flushEvents();
        set((state) => {
          const loadingHistory = omitKey(state.loadingHistory, sessionId);
          if (!result.ok) {
            return {
              loadingHistory,
              ...(state.activeSessionId === sessionId
                ? { notice: translate('sessions.errors.historyFailed', { error: result.error }) }
                : {}),
            };
          }
          let next = applyHistory(state, sessionId, result.messages);
          if (
            (state.runtimeBySession[sessionId]?.lastSeq ?? 0) === (snapshotRuntime?.lastSeq ?? 0) &&
            state.runtimeBySession[sessionId]?.contextSeq === snapshotRuntime?.contextSeq
          ) {
            next = applyContextRuntime(
              next,
              sessionId,
              result.contextRuntime,
              result.contextRuntimeSeq
            );
          }
          return { ...next, loadingHistory };
        });
      },

      async send(text) {
        const sessionId = get().activeSessionId;
        if (!sessionId) return false;
        const body = normalizePrompt(text);
        const images = get().draftImages[sessionId] ?? [];
        if (!body.trim() && images.length === 0) return false;
        const clearDraft = (state: SessionsState) => ({
          drafts: omitKey(state.drafts, sessionId),
          draftImages: omitKey(state.draftImages, sessionId),
        });
        // Running (or a prompt still in flight): queue it, it is sent when the turn settles
        flushEvents();
        if (
          sending.has(sessionId) ||
          get().stopping[sessionId] ||
          isBusy(statusOf(get(), sessionId)) ||
          recoveryBlocked(sessionId)
        ) {
          const item: QueuedMessage = { id: `queued-${++queueSeq}`, text: body, images };
          set((state) => ({
            ...clearDraft(state),
            queuedBySession: {
              ...state.queuedBySession,
              [sessionId]: [...(state.queuedBySession[sessionId] ?? []), item],
            },
          }));
          return true;
        }
        set(clearDraft);
        return deliver(sessionId, body, images, (state) => ({
          // Put what was not sent back in the input (unless the user already started a new draft;
          // text and images are checked separately)
          drafts:
            !text || state.drafts[sessionId]
              ? state.drafts
              : { ...state.drafts, [sessionId]: text },
          draftImages:
            images.length === 0 || state.draftImages[sessionId]
              ? state.draftImages
              : { ...state.draftImages, [sessionId]: images },
        }));
      },

      async steer(sessionId, queuedId) {
        flushEvents();
        if (get().stopping[sessionId]) return false;
        // Never hand a steer to the SDK while it is compacting/recovering: it may discard it.
        if (recoveryBlocked(sessionId)) {
          if (queuedId || queueOf(sessionId).length > 0) return false;
          if (get().activeSessionId !== sessionId) return false;
          return get().send(get().drafts[sessionId] ?? '');
        }
        clearSuggestion(sessionId);
        const queue = queueOf(sessionId);
        const item = queuedId
          ? queue.find((candidate) => candidate.id === queuedId)
          : queue[queue.length - 1];
        if (queuedId && !item) return false;
        const draftText = get().drafts[sessionId] ?? '';
        const message: QueuedMessage | undefined =
          item ??
          (() => {
            const text = normalizePrompt(draftText);
            const images = get().draftImages[sessionId] ?? [];
            return text.trim() || images.length > 0 ? { id: '', text, images } : undefined;
          })();
        if (!message) return false;
        const fromQueue = item !== undefined;
        const take = (state: SessionsState): Partial<SessionsState> =>
          fromQueue
            ? {
                queuedBySession: (() => {
                  const rest = (state.queuedBySession[sessionId] ?? []).filter(
                    (candidate) => candidate.id !== message.id
                  );
                  return rest.length > 0
                    ? { ...state.queuedBySession, [sessionId]: rest }
                    : omitKey(state.queuedBySession, sessionId);
                })(),
              }
            : {
                drafts: omitKey(state.drafts, sessionId),
                draftImages: omitKey(state.draftImages, sessionId),
              };
        const index = queue.indexOf(message);
        const putBack = (state: SessionsState): Partial<SessionsState> => {
          if (fromQueue) {
            const current = [...(state.queuedBySession[sessionId] ?? [])];
            current.splice(Math.min(index, current.length), 0, message);
            return { queuedBySession: { ...state.queuedBySession, [sessionId]: current } };
          }
          return {
            drafts: state.drafts[sessionId]
              ? state.drafts
              : { ...state.drafts, [sessionId]: draftText },
            draftImages:
              message.images.length === 0 || state.draftImages[sessionId]
                ? state.draftImages
                : { ...state.draftImages, [sessionId]: message.images },
          };
        };
        set(take);
        // Idle: nothing to steer, send it as a normal prompt
        if (!sending.has(sessionId) && !isBusy(statusOf(get(), sessionId))) {
          return deliver(sessionId, message.text, message.images, putBack);
        }
        // No echo: pi injects it into the run and the transcript shows it once it is delivered
        const result = await safely(() =>
          api.steer({
            sessionId,
            text: message.text,
            ...(message.images.length > 0 ? { images: message.images } : {}),
          })
        );
        if (result.ok) return true;
        set((state) => ({
          ...putBack(state),
          notice: translate('sessions.errors.steerFailed', { error: result.error }),
        }));
        return false;
      },

      resumeQueue(sessionId) {
        flushEvents();
        if (
          sending.has(sessionId) ||
          get().stopping[sessionId] ||
          isBusy(statusOf(get(), sessionId)) ||
          recoveryBlocked(sessionId)
        )
          return;
        releaseQueue(sessionId);
        drainQueue(sessionId, true);
      },

      async retryCompaction(sessionId) {
        flushEvents();
        const runtime = get().runtimeBySession[sessionId];
        if (
          !runtime?.recoveryRequired ||
          recoveryRequests.has(sessionId) ||
          get().recoveringCompaction[sessionId] ||
          get().stopping[sessionId] ||
          sending.has(sessionId) ||
          isBusy(statusOf(get(), sessionId)) ||
          compactionActive(runtime.compaction)
        )
          return;
        clearSuggestion(sessionId);
        holdQueue(sessionId);
        set((state) => ({
          recoveringCompaction: { ...state.recoveringCompaction, [sessionId]: true },
        }));
        recoveryRequests.add(sessionId);
        const result = await safely(() => api.retryCompaction(sessionId));
        flushEvents();
        recoveryRequests.delete(sessionId);
        if (removedSessions.has(sessionId)) return;
        if (!result.ok && get().recoveringCompaction[sessionId])
          set((state) => ({
            recoveringCompaction: omitKey(state.recoveringCompaction, sessionId),
            ...(state.activeSessionId === sessionId
              ? { notice: translate('chat.compactionRetryFailed', { error: result.error }) }
              : {}),
          }));
        // An ACK is only acceptance. Events/settled own completion; queued messages stay held.
      },

      removeQueued(sessionId, queuedId) {
        setQueue(sessionId, (queue) => queue.filter((item) => item.id !== queuedId));
      },

      recallQueued(sessionId, queuedId) {
        let result: RecallQueuedResult = 'missing';
        set((state) => {
          const queue = state.queuedBySession[sessionId] ?? [];
          const item = queue.find((candidate) => candidate.id === queuedId);
          // A drain/steer or deletion may have taken it since the row was rendered.
          if (!item || removedSessions.has(sessionId) || !findSession(state, sessionId)) {
            return state;
          }
          if (
            (state.drafts[sessionId] ?? '') !== '' ||
            (state.draftImages[sessionId]?.length ?? 0) > 0
          ) {
            result = 'draft-exists';
            return state;
          }
          const rest = queue.filter((candidate) => candidate.id !== queuedId);
          // Invalidate visible and pending suggestions without a second store update.
          const suggestion = state.replySuggestions[sessionId];
          if (suggestion) suggestionIgnored.set(sessionId, suggestion.roundId);
          bumpSuggestionVersion(sessionId);
          result = 'recalled';
          return {
            queuedBySession:
              rest.length > 0
                ? { ...state.queuedBySession, [sessionId]: rest }
                : omitKey(state.queuedBySession, sessionId),
            drafts: item.text
              ? { ...state.drafts, [sessionId]: item.text }
              : omitKey(state.drafts, sessionId),
            draftImages:
              item.images.length > 0
                ? { ...state.draftImages, [sessionId]: item.images }
                : omitKey(state.draftImages, sessionId),
            replySuggestions: omitKey(state.replySuggestions, sessionId),
          };
        });
        return result;
      },

      async abort() {
        const sessionId = get().activeSessionId;
        if (!sessionId || get().stopping[sessionId]) return;
        clearSuggestion(sessionId);
        set((state) => ({ stopping: { ...state.stopping, [sessionId]: true } }));
        // Stop keeps the queue but pauses it: the user decides what to send next
        holdQueue(sessionId);
        const result = await safely(() => api.abort(sessionId));
        set((state) => ({ stopping: omitKey(state.stopping, sessionId) }));
        if (!result.ok)
          set({ notice: translate('sessions.errors.abortFailed', { error: result.error }) });
      },

      async respondApproval(requestId, decision) {
        flushEvents();
        const request = findApproval(requestId);
        if (
          !request ||
          (request.expiresAt > 0 && request.expiresAt <= now()) ||
          get().approvalSubmissions[requestId]?.pending
        )
          return;
        const { sessionId } = request;
        // 保留请求直到送达：提交中禁用重复点击，失败后可重试且不复活已取消的审批。
        set((state) => ({
          approvalSubmissions: { ...state.approvalSubmissions, [requestId]: { pending: true } },
        }));
        const result = await safely(() => api.respondApproval({ sessionId, requestId, decision }));
        flushEvents();
        set((state) => {
          const submissions = omitKey(state.approvalSubmissions, requestId);
          if (result.ok) {
            return {
              ...dequeueApproval(state, sessionId, requestId),
              approvalSubmissions: submissions,
            };
          }
          const current = findApproval(requestId);
          if (!current || (current.expiresAt > 0 && current.expiresAt <= now()))
            return { approvalSubmissions: submissions };
          const error = translate('sessions.errors.approvalNotDelivered', { error: result.error });
          return {
            approvalSubmissions: { ...submissions, [requestId]: { pending: false, error } },
            notice: error,
          };
        });
      },

      setDraft(sessionId, text) {
        set((state) => ({
          drafts: text ? { ...state.drafts, [sessionId]: text } : omitKey(state.drafts, sessionId),
        }));
      },

      ignoreSuggestion(sessionId) {
        const suggestion = get().replySuggestions[sessionId];
        if (suggestion) suggestionIgnored.set(sessionId, suggestion.roundId);
        clearSuggestion(sessionId);
      },

      setDraftImages(sessionId, images) {
        set((state) => ({
          draftImages:
            images.length > 0
              ? { ...state.draftImages, [sessionId]: images }
              : omitKey(state.draftImages, sessionId),
        }));
      },

      attachImages(sessionId, images) {
        const current = get().draftImages[sessionId] ?? [];
        let total = current.reduce((sum, image) => sum + (base64ByteLength(image.data) ?? 0), 0);
        const added: ChatImage[] = [];
        let rejected: ImageRejection | undefined;
        for (const { data, mimeType } of images) {
          const bytes = isChatImageMimeType(mimeType) ? base64ByteLength(data) : null;
          if (!bytes) {
            rejected ??= 'invalid';
          } else if (current.length + added.length >= MAX_CHAT_IMAGES) {
            rejected ??= 'count';
          } else if (bytes > MAX_CHAT_IMAGE_BYTES || total + bytes > MAX_CHAT_IMAGES_TOTAL_BYTES) {
            rejected ??= 'size';
          } else {
            added.push({ data, mimeType });
            total += bytes;
          }
        }
        if (added.length > 0) {
          set((state) => ({
            draftImages: { ...state.draftImages, [sessionId]: [...current, ...added] },
          }));
        }
        return rejected;
      },

      removeDraftImage(sessionId, index) {
        set((state) => {
          const images = state.draftImages[sessionId];
          if (!images || index < 0 || index >= images.length) return {};
          const rest = images.filter((_image, at) => at !== index);
          return {
            draftImages:
              rest.length > 0
                ? { ...state.draftImages, [sessionId]: rest }
                : omitKey(state.draftImages, sessionId),
          };
        });
      },

      dismissWarning(sessionId) {
        set((state) => {
          const runtime = state.runtimeBySession[sessionId];
          if (!runtime?.warningSeq) return state;
          return {
            runtimeBySession: {
              ...state.runtimeBySession,
              [sessionId]: { ...runtime, dismissedWarningSeq: runtime.warningSeq },
            },
          };
        });
      },
      dismissNotice() {
        set({ notice: null });
      },

      async loadModelOptions(workspaceId = get().workspaceId) {
        const request = ++modelOptionsRequest;
        modelOptionsByWorkspace.set(workspaceId, request);
        const result = await safely(() => api.modelOptions(workspaceId ? { workspaceId } : {}));
        if (modelOptionsByWorkspace.get(workspaceId) !== request) return;
        if (!result.ok) {
          if (modelOptionsRequest === request) set({ modelOptionsError: result.error });
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
            ...(modelOptionsRequest === request
              ? { modelProviders: result.providers, modelOptionsError: null }
              : {}),
            lastModelByWorkspace,
          };
        });
      },

      async setSessionModel(sessionId, model) {
        const session = findSession(get(), sessionId);
        if (!session) return { ok: false, error: translate('sessions.errors.notFound') };
        if (sending.has(sessionId) || isBusy(statusOf(get(), sessionId))) {
          return { ok: false, error: translate('sessions.errors.switchWhileBusy') };
        }
        clearSuggestion(sessionId);
        const request = ++requestSeq;
        const previous = session.model;
        modelSwitches.set(sessionId, { request, model });
        set((state) => mapLists(state, sessionId, (item) => withModel(item, model)));
        const result = await safely(() => api.setModel({ sessionId, model }));
        // 用户连着点了几次：只认最近一次的回包，前面的结果由它覆盖
        if (modelSwitches.get(sessionId)?.request !== request) return result;
        modelSwitches.delete(sessionId);
        if (result.ok) {
          const updated = result.session;
          set((state) => ({
            ...mapLists(state, sessionId, () => updated),
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
          ...mapLists(state, sessionId, (item) => withModel(item, previous)),
          notice: translate('sessions.errors.setModelFailed', { error: result.error }),
        }));
        // 换回的是发起前看到的模型；以 Main 的记录为准再拉一次
        void get().loadSessions(session.workspaceId);
        return result;
      },

      async setApprovalMode(sessionId, mode) {
        const session = findSession(get(), sessionId);
        if (!session) return { ok: false, error: translate('sessions.errors.notFound') };
        const request = ++requestSeq;
        const previous = session.approvalMode;
        approvalSwitches.set(sessionId, { request, mode });
        const switchTo = (approvalMode: ApprovalMode) =>
          set((state) =>
            mapLists(state, sessionId, (item) =>
              item.approvalMode === approvalMode ? item : { ...item, approvalMode }
            )
          );
        switchTo(mode);
        const result = await safely(() => api.setApprovalMode({ sessionId, mode }));
        // Shift+Tab 连着按了几下：只认最近一次的回包，前面的结果由它覆盖
        if (approvalSwitches.get(sessionId)?.request !== request) return result;
        approvalSwitches.delete(sessionId);
        if (result.ok) {
          const { approvalMode, updatedAt } = result.session;
          set((state) =>
            mapLists(state, sessionId, (item) => ({ ...item, approvalMode, updatedAt }))
          );
          return result;
        }
        switchTo(previous);
        set({
          notice: translate('sessions.errors.setApprovalModeFailed', { error: result.error }),
        });
        // 换回的是发起前看到的档位；以 Main 的记录为准再拉一次
        void get().loadSessions(session.workspaceId);
        return result;
      },

      archiveSession: (sessionId) => setArchived(sessionId, true),

      unarchiveSession: (sessionId) => setArchived(sessionId, false),

      async removeSession(sessionId) {
        // 先归并已收到的事件，避免 16ms 攒批期间把刚开始运行的会话当成空闲。
        flushEvents();
        const before = get();
        const session = findSession(before, sessionId);
        if (!session) return { ok: false, error: translate('sessions.errors.notFound') };
        if (sending.has(sessionId) || isBusy(statusOf(before, sessionId))) {
          const error = translate('sessions.errors.removeWhileBusy');
          set({ notice: error });
          return { ok: false, error };
        }
        const { workspaceId } = session;
        clearSuggestion(sessionId);
        const lists = placeSessions(
          before,
          workspaceId,
          allSessionsOf(before, workspaceId).filter((item) => item.id !== sessionId)
        );
        const wasActive = before.activeSessionId === sessionId;
        const nextId = allSessionsOf(lists, workspaceId)[0]?.id ?? null;
        removedSessions.add(sessionId);
        historyRequests.delete(sessionId);
        set({
          ...lists,
          pausedQueues: omitKey(before.pausedQueues, sessionId),
          recoveringCompaction: omitKey(before.recoveringCompaction, sessionId),
          stopping: omitKey(before.stopping, sessionId),
          drafts: omitKey(before.drafts, sessionId),
          draftImages: omitKey(before.draftImages, sessionId),
          queuedBySession: omitKey(before.queuedBySession, sessionId),
          messagesBySession: omitKey(before.messagesBySession, sessionId),
          runtimeBySession: omitKey(before.runtimeBySession, sessionId),
          pendingApprovals: omitKey(before.pendingApprovals, sessionId),
          loadingHistory: omitKey(before.loadingHistory, sessionId),
          ...(wasActive ? { activeSessionId: nextId } : {}),
          ...(before.modelPickerFor === sessionId ? { modelPickerFor: null } : {}),
        });
        if (wasActive && nextId) void get().selectSession(nextId);
        const result = await safely(() => api.remove(sessionId));
        if (result.ok) {
          modelSwitches.delete(sessionId);
          approvalSwitches.delete(sessionId);
          suggestionTried.delete(sessionId);
          suggestionIgnored.delete(sessionId);
          return result;
        }
        removedSessions.delete(sessionId);
        const restore = <T>(current: Record<string, T>, previous: Record<string, T>) => {
          const value = previous[sessionId];
          return value === undefined ? current : { ...current, [sessionId]: value };
        };
        // 只恢复被删会话；用户已切到别的会话或工作区时，不抢回选中。
        const restoreActive =
          wasActive && get().workspaceId === before.workspaceId && get().activeSessionId === nextId;
        set((state) => ({
          ...placeSessions(state, workspaceId, [
            ...allSessionsOf(state, workspaceId).filter((item) => item.id !== sessionId),
            session,
          ]),
          drafts: restore(state.drafts, before.drafts),
          draftImages: restore(state.draftImages, before.draftImages),
          queuedBySession: restore(state.queuedBySession, before.queuedBySession),
          pausedQueues: restore(state.pausedQueues, before.pausedQueues),
          recoveringCompaction: restore(state.recoveringCompaction, before.recoveringCompaction),
          stopping: restore(state.stopping, before.stopping),
          messagesBySession: restore(state.messagesBySession, before.messagesBySession),
          runtimeBySession: restore(state.runtimeBySession, before.runtimeBySession),
          pendingApprovals: restore(state.pendingApprovals, before.pendingApprovals),
          ...(restoreActive ? { activeSessionId: sessionId } : {}),
          notice: translate('sessions.errors.removeFailed', { error: result.error }),
        }));
        if (restoreActive && before.loadingHistory[sessionId]) void get().selectSession(sessionId);
        return result;
      },

      openModelPicker(sessionId) {
        set({ modelPickerFor: sessionId });
      },

      closeModelPicker() {
        set({ modelPickerFor: null });
      },

      receiveEvent(envelope) {
        if (removedSessions.has(envelope.sessionId)) return;
        pending.push(envelope);
        if (scheduled) return;
        scheduled = true;
        schedule(flushEvents);
      },

      receiveApproval(request) {
        if (removedSessions.has(request.sessionId)) return;
        flushEvents();
        // 等审批属于运行中的状态：旧轮建议不能再出现 / 插入。
        clearSuggestion(request.sessionId);
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
