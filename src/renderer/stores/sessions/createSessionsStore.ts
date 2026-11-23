import type { ApprovalMode } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  appendChatFiles,
  base64ByteLength,
  type ChatFile,
  type ChatImage,
  isChatImageMimeType,
  MAX_CHAT_FILES,
  MAX_CHAT_FILES_TOTAL_CHARS,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
  type ModelProviderOption,
  type ReplySuggestion,
  type SessionEventEnvelope,
  type SessionModelRef,
  type SessionSummary,
  stripImageHints,
} from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { create, type StoreApi } from 'zustand';
import { translate } from '../../i18n';
import type { SessionsApi } from '../../lib/api/sessions';
import {
  addOptimisticMessage,
  applyContextRuntime,
  applyHistory,
  type ChatProjection,
  compactionActive,
  dequeueApproval,
  emptyProjection,
  enqueueApproval,
  isContextMetadata,
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
/** 文档附件没加进草稿的原因：`count` 超过个数上限，`size` 附件文字合计超限 */
export type FileRejection = 'count' | 'size';

/**
 * A message typed while the session was running. Kept in memory only (not in the transcript, which is a
 * projection of pi's jsonl): it shows up in the timeline once it is actually sent.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  images: ChatImage[];
  files: ChatFile[];
  /** 已经 steer 交给 pi、模型还没读到时，为交出的正文（附件块已拼入）；还在本地排队时没有 */
  handed?: string;
}

/** 撤回合并后的草稿是否超出图片或附件的上限（单张、单个已在加入时检查过） */
function overDraftLimits(images: readonly ChatImage[], files: readonly ChatFile[]): boolean {
  const bytes = images.reduce((sum, image) => sum + (base64ByteLength(image.data) ?? 0), 0);
  const chars = files.reduce((sum, file) => sum + file.text.length, 0);
  return (
    images.length > MAX_CHAT_IMAGES ||
    bytes > MAX_CHAT_IMAGES_TOTAL_BYTES ||
    files.length > MAX_CHAT_FILES ||
    chars > MAX_CHAT_FILES_TOTAL_CHARS
  );
}

/** 去掉交出标记，恢复为本地队列项 */
function asLocal({ handed: _handed, ...item }: QueuedMessage): QueuedMessage {
  return item;
}

type RecallQueuedResult = 'recalled' | 'draft-exists' | 'missing' | 'failed';
/** 撤回全部排队消息的结果：`too-many` 合并后超出草稿的图片或附件上限，`failed` 撤回请求失败 */
export type RecallAllResult = 'recalled' | 'empty' | 'too-many' | 'failed';

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
  /** 输入框里的文档附件，按会话保存（与 draftImages 并列） */
  draftFiles: Record<string, ChatFile[]>;
  /** 刚结束一轮生成的灰字建议；只在内存，与草稿分开，切换会话 / 新轮 / 换模型时清掉 */
  replySuggestions: Record<string, ReplySuggestion>;
  /**
   * 运行中排队的消息，最早的在前。回合已开始时非命令项逐条 steer 交给 pi（handed），当前工具调用结束后
   * 由模型在同一轮读到；命令和交出失败的留到本轮结束后按顺序作为 prompt 发出。Stop 中断时宿主丢弃已交出的，
   * 它们恢复为本地项接着发出。被拒的 prompt 回到队首，等下一次结算、发送或立即发送，不循环重试。
   */
  queuedBySession: Record<string, QueuedMessage[]>;
  recoveringCompaction: Record<string, true>;
  stopping: Record<string, true>;
  retryCompaction(sessionId: string): Promise<void>;
  /** 手动压缩请求在途（只到 ACK 为止，之后由会话状态与压缩事件接管） */
  compactRequests: Record<string, true>;
  /** 立即压缩空闲会话的上下文；忙时忽略，失败给提示 */
  compactContext(sessionId: string): Promise<void>;
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
  /**
   * 正在批量归档 / 删除的工作区及其进度（已处理 / 总数），只有正在跑批量的工作区才有键。
   * 不同工作区可同时进行；期间不响应该工作区的 sessions:changed，结束时只重拉一次
   */
  bulkByWorkspace: Record<string, { kind: 'archive' | 'remove'; done: number; total: number }>;
  /** 等用户确认的批量删除；确认前不会删任何会话 */
  pendingRemoval: {
    workspaceId: string;
    sessionIds: string[];
    /** 其中 worktree 有未合并或未提交改动的会话；null 表示还在向 Main 查 */
    blocked: string[] | null;
  } | null;
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
   * 向选中的会话发送文本与它的草稿图片、附件；只有图片或附件也能发。什么都没有时返回 false。
   * 会话运行中、上一条还在途或队列里还有消息时排到队尾，按先进先出发出，不插队
   */
  send(text: string): Promise<boolean>;
  /**
   * 立即发送（机制对应 Claude Code 的 Ctrl+Enter，快捷键为 Ctrl/Cmd+S），作用于整个队列：草稿先排到队尾。会话空闲时照常发出队首；
   * 运行中先把本地项交给 pi，再在模型思考、输出或等审批时停止当前回合，结算后排队消息接着发出；
   * 工具执行中或 worker 会话不打断，消息在工具执行完后由 pi 交给模型。没有可发内容、停止中、
   * 等待上下文恢复或停止失败时返回 false
   */
  steer(sessionId: string): Promise<boolean>;
  /** 删除一条排队消息；已交给 pi 的先全部撤回再删 */
  removeQueued(sessionId: string, queuedId: string): Promise<void>;
  /** 把一条排队消息撤回到空草稿；已交给 pi 的先全部撤回 */
  recallQueued(sessionId: string, queuedId: string): Promise<RecallQueuedResult>;
  /** 撤回全部排队消息（对应 Claude Code 的 Up）：文字每条一行放在草稿之前，图片、附件按顺序并入草稿 */
  recallAllQueued(sessionId: string): Promise<RecallAllResult>;
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
  /** 恢复已发送或保存的草稿附件：原样替换，不重新检查上限 */
  setDraftFiles(sessionId: string, files: ChatFile[]): void;
  /**
   * 往会话的草稿里加文档附件：按顺序收下放得下的（个数、合计字数在上限内），其余不加。
   * 返回第一个没加进去的原因；都加进去时为 undefined
   */
  attachFiles(sessionId: string, files: readonly ChatFile[]): FileRejection | undefined;
  /** 从会话的草稿里移除第 index 个附件 */
  removeDraftFile(sessionId: string, index: number): void;
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
   * 开关会话的计划模式（不分角色，派发出的 worker 会话除外）：同换审批档位，先乐观更新，Main 回包后以它的记录为准；
   * 失败时换回原来的状态、提示原因并重拉列表。运行中、等审批时也可以切。
   */
  setPlanMode(sessionId: string, enabled: boolean): Promise<IpcResult<{ session: SessionSummary }>>;
  /**
   * 归档会话：先在列表里标上（乐观更新），Main 回包后以它的归档时间为准；失败时换回、提示原因并重拉列表。
   * 运行中、等审批或消息在途时直接拒绝。
   */
  archiveSession(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 恢复归档的会话：同上；恢复算一次更新，会话回到列表顶部 */
  unarchiveSession(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 从列表移除会话并清空本地投影；运行中拒绝，失败时恢复。底层记录文件保留。 */
  removeSession(sessionId: string, force?: boolean): Promise<IpcResult>;
  /**
   * 批量归档 / 删除工作区里的会话：逐个调用单个会话的操作，期间合并列表刷新，结束后只重拉一次；
   * 运行中、等审批的会话照单个操作的规则拒绝，失败汇总成一条提示；还有 worker 在跑的主 agent（awaitingWorkers）跳过并提示。
   * 另一批进行中时什么都不做。
   */
  archiveSessions(workspaceId: string, sessionIds: readonly string[]): Promise<BulkResult>;
  /**
   * 删除分两步：先登记待确认并向 Main 查哪些会话的 worktree 有未合并的改动（界面据此弹确认框），确认后才删；
   * 没勾 `force` 时跳过这些会话并计入提示。取消则丢弃
   */
  requestRemoveSessions(workspaceId: string, sessionIds: readonly string[]): void;
  confirmRemoveSessions(force?: boolean): Promise<BulkResult>;
  cancelRemoveSessions(): void;
  /** 一键归档工作区里的闲置会话：跳过运行中、等审批、消息在途、正在查看与已归档的；还有 worker 在跑的主 agent 经 archiveSessions 跳过并提示 */
  archiveIdleSessions(workspaceId: string): Promise<BulkResult>;
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

/** 批量操作的结果：成功几个、未处理几个 */
export interface BulkResult {
  done: number;
  failed: number;
  /** 批量归档时跳过的、还有 worker 在跑的主 agent 会话；没有时省略 */
  skipped?: number;
}

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

/** planMode 只在开启时带（与 Main 的记录同形） */
function withPlanMode(session: SessionSummary, enabled: boolean): SessionSummary {
  const { planMode: _previous, ...rest } = session;
  return enabled ? { ...rest, planMode: true } : rest;
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
  /** 在途的开关计划模式：同上 */
  const planSwitches = new Map<string, { request: number; enabled: boolean }>();
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
  /** 正在把队列项 steer 给 pi 的会话：同一会话串行交出，撤回前等它停下 */
  const pumps = new Map<string, Promise<void>>();
  /** 本轮交出失败的会话：剩下的留到本轮结束后由 drain 发出，结算时清除 */
  const handFailed = new Set<string>();
  /** 正在撤回已交出消息的会话：期间不再交出 */
  const takingBack = new Set<string>();

  return create<SessionsState>()((set, get) => {
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
      if ((fresh.draftFiles[sessionId]?.length ?? 0) > 0) return;
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
      const failedSettlements = new Set<SessionEventEnvelope>();
      set((state) => {
        let next = state;
        for (const envelope of received) {
          const reduced = reduceSessionEvent(next, envelope, now());
          // Stale events must not run side effects either (drain/suggestions).
          if (reduced !== next) {
            batch.push(envelope);
            const runtime = reduced.runtimeBySession[envelope.sessionId];
            if (
              envelope.event.type === 'agent_settled' &&
              (envelope.event.aborted || runtime?.error || runtime?.pendingAssistantFailure)
            )
              failedSettlements.add(envelope);
          }
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
      const settled = new Set<string>();
      const normal = new Map<string, number>();
      for (const envelope of batch) {
        const { sessionId, event } = envelope;
        if (
          (event.type === 'agent_settled' &&
            (event.aborted || !get().runtimeBySession[sessionId]?.recoveryRequired)) ||
          event.type === 'error' ||
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
        // queue there as well.
        if (event.type === 'context_runtime' && !recoveryBlocked(sessionId)) {
          settled.add(sessionId);
          const roundId = get().runtimeBySession[sessionId]?.settledSeq;
          if (roundId !== undefined) normal.set(sessionId, roundId);
        }
        // A finished slash command sends the queue on, but never asks for a reply suggestion.
        if (event.type === 'command_end') settled.add(sessionId);
        // A finished manual compaction settles the session in the reducer; drainQueue skips busy ones.
        if (event.type === 'compaction' && !compactionActive(event.state)) settled.add(sessionId);
        if (event.type !== 'agent_settled') continue;
        if (!failedSettlements.has(envelope)) normal.set(sessionId, event.seq);
        settled.add(sessionId);
      }
      // 模型读到的已交出消息移出队列（先于结算处理）；结算时剩下的：正常结束前 pi 已投递完，视为已交付；
      // 中断时宿主已丢弃它们，恢复为本地项，保持原顺序接着发出
      for (const { sessionId, event } of batch)
        if (event.type === 'message_end' && event.role === 'user')
          markDelivered(sessionId, event.text);
      for (const { sessionId, event } of batch) {
        if (event.type !== 'agent_settled') continue;
        handFailed.delete(sessionId);
        if (!queueOf(sessionId).some((item) => item.handed !== undefined)) continue;
        setQueue(sessionId, (queue) =>
          event.aborted ? queue.map(asLocal) : queue.filter((item) => item.handed === undefined)
        );
      }
      // Normal, failed and stopped turns alike continue with the next queued message.
      for (const sessionId of settled) drainQueue(sessionId);
      for (const sessionId of new Set(batch.map((envelope) => envelope.sessionId)))
        void pump(sessionId);
      // 队列真的空了、状态仍 idle 才请求；drainQueue 发了下一条时这里会看到 running
      for (const [sessionId, roundId] of normal) maybeRequestSuggestion(sessionId, roundId);
    }

    function recoveryBlocked(sessionId: string): boolean {
      return (
        recoveryHeld(sessionId) || Boolean(get().runtimeBySession[sessionId]?.pendingPromptCount)
      );
    }

    /** 真正的恢复阻塞：不看 pendingPromptCount，自己交出的 steer 也会让它大于 0 */
    function recoveryHeld(sessionId: string): boolean {
      const runtime = get().runtimeBySession[sessionId];
      return Boolean(
        get().recoveringCompaction[sessionId] ||
          recoveryRequests.has(sessionId) ||
          compactionActive(runtime?.compaction) ||
          runtime?.recoveryRequired
      );
    }

    /** 有工具在执行（等审批时不算，那时可以立刻停止） */
    function toolRunning(sessionId: string): boolean {
      const runtime = get().runtimeBySession[sessionId];
      return (
        Object.keys(runtime?.toolStartedAt ?? {}).length > 0 &&
        statusOf(get(), sessionId) !== 'waiting-approval'
      );
    }

    /**
     * 运行中、回合已开始（没有未确认的回显、没有 prompt 在途）、不在停止或撤回中、没有恢复阻塞时才交出。
     * 斜杠命令执行中不是模型回合（没有 agent_settled），不交出，等 command_end 后由 drain 发出
     */
    function canHand(sessionId: string): boolean {
      const state = get();
      const lastUser = (state.messagesBySession[sessionId] ?? []).findLast(
        (message) => message.role === 'user'
      );
      return (
        !lastUser?.command &&
        isBusy(statusOf(state, sessionId)) &&
        !sending.has(sessionId) &&
        !state.stopping[sessionId] &&
        !takingBack.has(sessionId) &&
        !handFailed.has(sessionId) &&
        !recoveryHeld(sessionId) &&
        !(state.messagesBySession[sessionId] ?? []).some(
          (message) => message.optimistic && !message.failed
        )
      );
    }

    /**
     * 把本地队列项按顺序逐条 steer 给 pi，串行等 ACK；命令（`/` 开头）留到本轮结束后由 drain 发出。
     * 先标为 handed 再请求，在途时删除或撤回也会先去宿主撤回；失败的恢复为本地项，本轮不再交出
     */
    function pump(sessionId: string): Promise<void> {
      const running = pumps.get(sessionId);
      if (running) return running;
      if (!canHand(sessionId)) return Promise.resolve();
      // 没碰到 await 就结束时 finally 先于 set 执行，不能把已结束的 promise 留在表里
      let done = false;
      const run = (async () => {
        try {
          for (;;) {
            if (!canHand(sessionId)) return;
            const item = queueOf(sessionId).find(
              (candidate) => candidate.handed === undefined && !candidate.text.startsWith('/')
            );
            if (!item) return;
            const text = appendChatFiles(item.text, item.files);
            setQueue(sessionId, (queue) =>
              queue.map((candidate) =>
                candidate.id === item.id ? { ...candidate, handed: text } : candidate
              )
            );
            const result = await safely(() =>
              api.steer({
                sessionId,
                text,
                ...(item.images.length > 0 ? { images: item.images } : {}),
              })
            );
            if (result.ok) continue;
            handFailed.add(sessionId);
            setQueue(sessionId, (queue) =>
              queue.map((candidate) => (candidate.id === item.id ? asLocal(candidate) : candidate))
            );
            return;
          }
        } finally {
          done = true;
          pumps.delete(sessionId);
        }
      })();
      if (!done) pumps.set(sessionId, run);
      return run;
    }

    /** 模型读到了一条已交出的消息：按交出时的正文匹配（图片提示行的处理同 reducer 确认回显），移出队列 */
    function markDelivered(sessionId: string, text: string): void {
      const item = queueOf(sessionId).find(
        (candidate) =>
          candidate.handed !== undefined &&
          (candidate.handed === text ||
            (candidate.images.length > 0 && stripImageHints(text) === candidate.handed))
      );
      if (item)
        setQueue(sessionId, (queue) => queue.filter((candidate) => candidate.id !== item.id));
    }

    /**
     * 从宿主撤回所有已交出、模型还没读到的消息：按返回的原文顺序匹配 handed 项，匹配上的恢复为本地项，
     * 没匹配上的视为已交付并移除。调用方先把会话放进 takingBack，期间不再交出。失败时提示、不改队列
     */
    async function takeBack(sessionId: string): Promise<boolean> {
      await pumps.get(sessionId);
      if (!queueOf(sessionId).some((item) => item.handed !== undefined)) return true;
      const result = await safely(() => api.takeBackQueued(sessionId));
      flushEvents();
      if (!result.ok) {
        set({ notice: translate('sessions.errors.takeBackFailed', { error: result.error }) });
        return false;
      }
      let next = 0;
      setQueue(sessionId, (queue) =>
        queue.flatMap((item) => {
          if (item.handed === undefined) return [item];
          const found = result.texts.indexOf(item.handed, next);
          if (found < 0) return [];
          next = found + 1;
          return [asLocal(item)];
        })
      );
      return true;
    }

    /** 把一条本地队列项撤回到空草稿，与移出队列原子完成 */
    function recallLocal(sessionId: string, queuedId: string): RecallQueuedResult {
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
          (state.draftImages[sessionId]?.length ?? 0) > 0 ||
          (state.draftFiles[sessionId]?.length ?? 0) > 0
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
          draftFiles:
            item.files.length > 0
              ? { ...state.draftFiles, [sessionId]: item.files }
              : omitKey(state.draftFiles, sessionId),
          replySuggestions: omitKey(state.replySuggestions, sessionId),
        };
      });
      return result;
    }

    /** 撤回已交出的消息后再做 `update`；结束后其余本地项由 pump 重新交出 */
    async function withTakeBack<T>(sessionId: string, update: (ok: boolean) => T): Promise<T> {
      takingBack.add(sessionId);
      try {
        return update(await takeBack(sessionId));
      } finally {
        takingBack.delete(sessionId);
        void pump(sessionId);
      }
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

    /** 停止当前回合（Stop 与「立即发送」共用），返回是否停止成功；队列不清空，结算后照常发出队首 */
    async function stopTurn(sessionId: string): Promise<boolean> {
      clearSuggestion(sessionId);
      set((state) => ({ stopping: { ...state.stopping, [sessionId]: true } }));
      // Stop ends the turn, not the queue: the next queued message follows once it settles
      const result = await safely(() => api.abort(sessionId));
      set((state) => ({ stopping: omitKey(state.stopping, sessionId) }));
      if (!result.ok)
        set({ notice: translate('sessions.errors.abortFailed', { error: result.error }) });
      // Safety net: resync the status from Main in case this chat missed its settlement.
      const session = result.ok ? findSession(get(), sessionId) : undefined;
      if (session) void get().loadSessions(session.workspaceId);
      // The settled event may have arrived while stopping held the drain back
      drainQueue(sessionId);
      return result.ok;
    }

    /**
     * Prompt the session with an optimistic echo. On failure the echo is withdrawn with the error and
     * `restore` puts the message back where it came from (draft or queue)
     */
    async function deliver(
      sessionId: string,
      body: string,
      images: ChatImage[],
      files: ChatFile[],
      restore: (state: SessionsState) => Partial<SessionsState>
    ): Promise<boolean> {
      const previous = statusOf(get(), sessionId);
      // 附件块拼进正文：乐观回显与 pi jsonl 里的 user 正文一致，reducer 按正文匹配回显
      const text = appendChatFiles(body, files);
      clearSuggestion(sessionId);
      sending.add(sessionId);
      const id = `local-${++localSeq}`;
      set((state) =>
        addOptimisticMessage(state, sessionId, { id, text, images, createdAt: now() })
      );
      let rejected = false;
      try {
        const result = await safely(() =>
          api.prompt({ sessionId, text, ...(images.length > 0 ? { images } : {}) })
        );
        flushEvents();
        if (result.ok) return true;
        // Only this echo's message/history confirmation can outweigh a failed ACK.
        // A backend pending count may belong to an older input rejected by the recovery gate.
        const current = get();
        const echo = current.messagesBySession[sessionId]?.find((message) => message.id === id);
        if (!echo?.optimistic) return true;
        rejected = true;
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
        // A rejected prompt is not retried here, or a persistently failing session would loop:
        // the queue continues on the next settlement, a new message or "send now".
        if (!rejected) {
          drainQueue(sessionId);
          void pump(sessionId);
        }
      }
    }

    /**
     * Send the oldest queued message once the session is idle or ended with an error. Stop in flight,
     * approvals, a prompt in flight and compaction/recovery only delay it; nothing pauses the queue
     */
    function drainQueue(sessionId: string): void {
      if (
        get().stopping[sessionId] ||
        (get().pendingApprovals[sessionId]?.length ?? 0) > 0 ||
        sending.has(sessionId) ||
        recoveryBlocked(sessionId) ||
        isBusy(statusOf(get(), sessionId))
      )
        return;
      const [next] = queueOf(sessionId);
      if (!next || next.handed !== undefined) return;
      setQueue(sessionId, (queue) => queue.filter((item) => item.id !== next.id));
      void deliver(sessionId, next.text, next.images, next.files, (state) => {
        // Put it back in front; deliver does not retry it right away so a broken session does not loop
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
      archived: boolean,
      bulk = false
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
      // 批量时由调用方汇总提示、最后统一重拉
      if (bulk) return result;
      set({
        notice: translate(
          archived ? 'sessions.errors.archiveFailed' : 'sessions.errors.unarchiveFailed',
          { error: result.error }
        ),
      });
      void get().loadSessions(workspaceId);
      return result;
    }

    /** 逐个执行（顺序调用，不并发），列表只在最后重拉一次；有失败时把数量与原因汇总成一条提示 */
    async function runBulk(
      workspaceId: string,
      sessionIds: readonly string[],
      kind: 'archive' | 'remove',
      run: (sessionId: string) => Promise<IpcResult>,
      skipped = 0
    ): Promise<BulkResult> {
      // 同一工作区不重入；别的工作区的批量操作不受影响
      if (Object.hasOwn(get().bulkByWorkspace, workspaceId)) return { done: 0, failed: 0 };
      const skippedNotice =
        skipped > 0 ? translate('sessions.bulk.awaitingWorkersSkipped', { count: skipped }) : null;
      const withSkipped = (result: BulkResult): BulkResult =>
        skipped > 0 ? { ...result, skipped } : result;
      const ids = [...new Set(sessionIds)];
      if (ids.length === 0) {
        if (skippedNotice) set({ notice: skippedNotice });
        return withSkipped({ done: 0, failed: 0 });
      }
      // 删正在查看的会话会跳到下一个：放到最后删，免得跳到一个马上要删的会话
      const active = get().activeSessionId;
      ids.sort((a, b) => Number(a === active) - Number(b === active));
      const total = ids.length;
      // 多个工作区的循环会交错执行：只改本工作区的键，不覆盖别的工作区的进度
      const setProgress = (done: number) =>
        set((state) => ({
          bulkByWorkspace: { ...state.bulkByWorkspace, [workspaceId]: { kind, done, total } },
        }));
      setProgress(0);
      let done = 0;
      const reasons = new Set<string>();
      try {
        for (const [index, sessionId] of ids.entries()) {
          const result = await run(sessionId);
          if (result.ok) done++;
          else reasons.add(result.error);
          setProgress(index + 1);
        }
      } finally {
        set((state) => ({ bulkByWorkspace: omitKey(state.bulkByWorkspace, workspaceId) }));
      }
      const failed = ids.length - done;
      const partial =
        failed > 0
          ? translate(
              kind === 'archive' ? 'sessions.bulk.archivePartial' : 'sessions.bulk.removePartial',
              { done, failed, reasons: [...reasons].join('；') }
            )
          : null;
      const notice = [partial, skippedNotice].filter((part) => part !== null).join(' ');
      if (notice) set({ notice });
      await get().loadSessions(workspaceId);
      return withSkipped({ done, failed });
    }

    return {
      ...emptyProjection(),
      workspaceId: null,
      sessionsByWorkspace: {},
      archivedByWorkspace: {},
      activeSessionId: null,
      drafts: {},
      draftImages: {},
      draftFiles: {},
      replySuggestions: {},
      queuedBySession: {},
      recoveringCompaction: {},
      compactRequests: {},
      stopping: {},
      loadingHistory: {},
      listErrors: {},
      approvalSubmissions: {},
      notice: null,
      bulkByWorkspace: {},
      pendingRemoval: null,
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
            const planning = planSwitches.get(session.id);
            const withPendingModel = pending ? withModel(session, pending.model) : session;
            const withPendingPlan = planning
              ? withPlanMode(withPendingModel, planning.enabled)
              : withPendingModel;
            return switching
              ? { ...withPendingPlan, approvalMode: switching.mode }
              : withPendingPlan;
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
            const hasData =
              session.contextRuntime !== undefined || session.contextRuntimeSeq !== undefined;
            // A rejected snapshot must not reset progress through its associated status either.
            // Without runtime data nothing can be rejected; an unchanged state is just a no-op.
            if (hydrated === next && hasData) skip.add(session.id);
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
        const recovered = sessions.filter(
          (session) =>
            synchronized.has(session.id) &&
            !recoveryRequests.has(session.id) &&
            (session.status === 'idle' || session.status === 'error') &&
            get().recoveringCompaction[session.id]
        );
        if (recovered.length > 0) {
          set((state) => {
            const recoveringCompaction = { ...state.recoveringCompaction };
            for (const session of recovered) delete recoveringCompaction[session.id];
            return { recoveringCompaction };
          });
        }
        for (const session of sessions) {
          if (synchronized.has(session.id) && (get().queuedBySession[session.id]?.length ?? 0) > 0)
            drainQueue(session.id);
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
              result.contextRuntimeSeq,
              result.contextRecovery?.recoveryRequired
            );
          }
          return { ...next, loadingHistory };
        });
        if (result.ok) drainQueue(sessionId);
      },

      async send(text) {
        const sessionId = get().activeSessionId;
        if (!sessionId) return false;
        const body = normalizePrompt(text);
        const images = get().draftImages[sessionId] ?? [];
        const files = get().draftFiles[sessionId] ?? [];
        if (!body.trim() && images.length === 0 && files.length === 0) return false;
        const clearDraft = (state: SessionsState) => ({
          drafts: omitKey(state.drafts, sessionId),
          draftImages: omitKey(state.draftImages, sessionId),
          draftFiles: omitKey(state.draftFiles, sessionId),
        });
        // Running, a prompt still in flight or older queued messages: queue it behind them (FIFO),
        // it is sent when the turn settles
        flushEvents();
        if (
          sending.has(sessionId) ||
          get().stopping[sessionId] ||
          isBusy(statusOf(get(), sessionId)) ||
          recoveryBlocked(sessionId) ||
          queueOf(sessionId).length > 0
        ) {
          const item: QueuedMessage = { id: `queued-${++queueSeq}`, text: body, images, files };
          set((state) => ({
            ...clearDraft(state),
            queuedBySession: {
              ...state.queuedBySession,
              [sessionId]: [...(state.queuedBySession[sessionId] ?? []), item],
            },
          }));
          // Idle behind older messages (e.g. after a rejected prompt): send the oldest now
          drainQueue(sessionId);
          // 运行中：交给 pi，当前工具调用结束后由模型在同一轮读到
          await pump(sessionId);
          return true;
        }
        set(clearDraft);
        return deliver(sessionId, body, images, files, (state) => ({
          // Put what was not sent back in the input (unless the user already started a new draft;
          // text, images and files are checked separately)
          drafts:
            !text || state.drafts[sessionId]
              ? state.drafts
              : { ...state.drafts, [sessionId]: text },
          draftImages:
            images.length === 0 || state.draftImages[sessionId]
              ? state.draftImages
              : { ...state.draftImages, [sessionId]: images },
          draftFiles:
            files.length === 0 || state.draftFiles[sessionId]
              ? state.draftFiles
              : { ...state.draftFiles, [sessionId]: files },
        }));
      },

      async steer(sessionId) {
        flushEvents();
        if (get().stopping[sessionId]) return false;
        // 输入框里的草稿排在已排队的消息后面
        const text = normalizePrompt(get().drafts[sessionId] ?? '');
        const images = get().draftImages[sessionId] ?? [];
        const files = get().draftFiles[sessionId] ?? [];
        const drafted = Boolean(text.trim()) || images.length > 0 || files.length > 0;
        if (drafted) {
          const item: QueuedMessage = { id: `queued-${++queueSeq}`, text, images, files };
          set((state) => ({
            drafts: omitKey(state.drafts, sessionId),
            draftImages: omitKey(state.draftImages, sessionId),
            draftFiles: omitKey(state.draftFiles, sessionId),
            queuedBySession: {
              ...state.queuedBySession,
              [sessionId]: [...(state.queuedBySession[sessionId] ?? []), item],
            },
          }));
        }
        if (queueOf(sessionId).length === 0) return false;
        clearSuggestion(sessionId);
        // 空闲：照常发出队首
        if (!sending.has(sessionId) && !isBusy(statusOf(get(), sessionId))) {
          drainQueue(sessionId);
          return true;
        }
        // 上下文恢复中不交出也不打断，排队等恢复完成
        if (recoveryHeld(sessionId)) return drafted;
        await pump(sessionId);
        // 工具执行中（pi 不能把它转到后台）或 worker 会话（中断会把尝试判为失败）不打断：
        // 已交出的消息在当前工具执行完后由 pi 交给模型
        if (
          findSession(get(), sessionId)?.dispatchId !== undefined ||
          toolRunning(sessionId) ||
          get().stopping[sessionId] ||
          recoveryHeld(sessionId)
        )
          return true;
        // 模型在思考、输出或等审批：打断本轮，中断结算后排队消息接着发出
        return stopTurn(sessionId);
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
        set((state) => ({
          recoveringCompaction: { ...state.recoveringCompaction, [sessionId]: true },
          runtimeBySession: {
            ...state.runtimeBySession,
            [sessionId]: { ...runtime, error: undefined, pendingAssistantFailure: undefined },
          },
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
        // ACK only accepts the request. If completion events arrived first, re-check now
        // that request exclusion is gone; otherwise the runtime gate still blocks delivery.
        drainQueue(sessionId);
      },

      async compactContext(sessionId) {
        flushEvents();
        const runtime = get().runtimeBySession[sessionId];
        if (
          runtime?.recoveryRequired ||
          recoveryRequests.has(sessionId) ||
          get().compactRequests[sessionId] ||
          get().recoveringCompaction[sessionId] ||
          get().stopping[sessionId] ||
          sending.has(sessionId) ||
          isBusy(statusOf(get(), sessionId)) ||
          compactionActive(runtime?.compaction)
        )
          return;
        clearSuggestion(sessionId);
        set((state) => ({ compactRequests: { ...state.compactRequests, [sessionId]: true } }));
        const result = await safely(() => api.compact(sessionId));
        flushEvents();
        set((state) => ({
          compactRequests: omitKey(state.compactRequests, sessionId),
          ...(!result.ok && state.activeSessionId === sessionId
            ? { notice: translate('chat.compactFailed', { error: result.error }) }
            : {}),
        }));
      },

      async removeQueued(sessionId, queuedId) {
        const drop = () =>
          setQueue(sessionId, (queue) => queue.filter((item) => item.id !== queuedId));
        const item = queueOf(sessionId).find((candidate) => candidate.id === queuedId);
        if (item?.handed === undefined) {
          drop();
          return;
        }
        // 已交给 pi：先全部撤回再删，其余的随后重新交出
        await withTakeBack(sessionId, (ok) => {
          if (ok) drop();
        });
      },

      async recallQueued(sessionId, queuedId) {
        const item = queueOf(sessionId).find((candidate) => candidate.id === queuedId);
        if (item?.handed === undefined) return recallLocal(sessionId, queuedId);
        const state = get();
        if (
          (state.drafts[sessionId] ?? '') !== '' ||
          (state.draftImages[sessionId]?.length ?? 0) > 0 ||
          (state.draftFiles[sessionId]?.length ?? 0) > 0
        )
          return 'draft-exists';
        return withTakeBack(sessionId, (ok) => (ok ? recallLocal(sessionId, queuedId) : 'failed'));
      },

      async recallAllQueued(sessionId) {
        if (queueOf(sessionId).length === 0) return 'empty';
        return withTakeBack(sessionId, (ok): RecallAllResult => {
          if (!ok) return 'failed';
          const queue = queueOf(sessionId);
          if (queue.length === 0 || removedSessions.has(sessionId)) return 'empty';
          const state = get();
          const images = [
            ...queue.flatMap((item) => item.images),
            ...(state.draftImages[sessionId] ?? []),
          ];
          const files = [
            ...queue.flatMap((item) => item.files),
            ...(state.draftFiles[sessionId] ?? []),
          ];
          if (overDraftLimits(images, files)) return 'too-many';
          // 每条一行，放在已输入的文字之前
          const draft = state.drafts[sessionId] ?? '';
          const text = [...queue.map((item) => item.text), draft]
            .filter((line) => line !== '')
            .join('\n');
          clearSuggestion(sessionId);
          set((current) => ({
            queuedBySession: omitKey(current.queuedBySession, sessionId),
            drafts: text
              ? { ...current.drafts, [sessionId]: text }
              : omitKey(current.drafts, sessionId),
            draftImages:
              images.length > 0
                ? { ...current.draftImages, [sessionId]: images }
                : omitKey(current.draftImages, sessionId),
            draftFiles:
              files.length > 0
                ? { ...current.draftFiles, [sessionId]: files }
                : omitKey(current.draftFiles, sessionId),
          }));
          return 'recalled';
        });
      },

      abort() {
        const sessionId = get().activeSessionId;
        if (!sessionId || get().stopping[sessionId]) return Promise.resolve();
        // 直接返回 stopTurn 的 promise，不多包一层 await，保持与原实现相同的结算时序
        return stopTurn(sessionId) as Promise<unknown> as Promise<void>;
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

      setDraftFiles(sessionId, files) {
        set((state) => ({
          draftFiles:
            files.length > 0
              ? { ...state.draftFiles, [sessionId]: files }
              : omitKey(state.draftFiles, sessionId),
        }));
      },

      attachFiles(sessionId, files) {
        const current = get().draftFiles[sessionId] ?? [];
        let total = current.reduce((sum, file) => sum + file.text.length, 0);
        const added: ChatFile[] = [];
        let rejected: FileRejection | undefined;
        for (const file of files) {
          if (current.length + added.length >= MAX_CHAT_FILES) {
            rejected ??= 'count';
          } else if (total + file.text.length > MAX_CHAT_FILES_TOTAL_CHARS) {
            rejected ??= 'size';
          } else {
            added.push(file);
            total += file.text.length;
          }
        }
        if (added.length > 0) {
          set((state) => ({
            draftFiles: { ...state.draftFiles, [sessionId]: [...current, ...added] },
          }));
        }
        return rejected;
      },

      removeDraftFile(sessionId, index) {
        set((state) => {
          const files = state.draftFiles[sessionId];
          if (!files || index < 0 || index >= files.length) return {};
          const rest = files.filter((_file, at) => at !== index);
          return {
            draftFiles:
              rest.length > 0
                ? { ...state.draftFiles, [sessionId]: rest }
                : omitKey(state.draftFiles, sessionId),
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

      async setPlanMode(sessionId, enabled) {
        const session = findSession(get(), sessionId);
        if (!session) return { ok: false, error: translate('sessions.errors.notFound') };
        const request = ++requestSeq;
        const previous = session.planMode === true;
        planSwitches.set(sessionId, { request, enabled });
        const switchTo = (on: boolean) =>
          set((state) =>
            mapLists(state, sessionId, (item) =>
              (item.planMode === true) === on ? item : withPlanMode(item, on)
            )
          );
        switchTo(enabled);
        const result = await safely(() => api.setPlanMode({ sessionId, enabled }));
        // 连着点了几下：只认最近一次的回包，前面的结果由它覆盖
        if (planSwitches.get(sessionId)?.request !== request) return result;
        planSwitches.delete(sessionId);
        if (result.ok) {
          const { planMode, updatedAt } = result.session;
          set((state) =>
            mapLists(state, sessionId, (item) => ({
              ...withPlanMode(item, planMode === true),
              updatedAt,
            }))
          );
          return result;
        }
        switchTo(previous);
        set({
          notice: translate('sessions.errors.setPlanModeFailed', { error: result.error }),
        });
        // 换回的是发起前看到的状态；以 Main 的记录为准再拉一次
        void get().loadSessions(session.workspaceId);
        return result;
      },

      archiveSession: (sessionId) => setArchived(sessionId, true),

      unarchiveSession: (sessionId) => setArchived(sessionId, false),

      archiveSessions(workspaceId, sessionIds) {
        // 主 agent 还有 worker 在跑：归档会留下没人审查、合并的「无头 worker」，批量操作跳过
        const ids = [...new Set(sessionIds)];
        const awaiting = (id: string) => {
          const session = findSession(get(), id);
          return session?.awaitingWorkers === true && session.archivedAt === undefined;
        };
        const kept = ids.filter((id) => !awaiting(id));
        return runBulk(
          workspaceId,
          kept,
          'archive',
          (sessionId) => setArchived(sessionId, true, true),
          ids.length - kept.length
        );
      },

      requestRemoveSessions(workspaceId, sessionIds) {
        if (sessionIds.length === 0) return;
        const ids = [...new Set(sessionIds)];
        const withWorktree = ids.filter((id) => findSession(get(), id)?.worktreeId !== undefined);
        const pending = { workspaceId, sessionIds: ids, blocked: withWorktree.length ? null : [] };
        set({ pendingRemoval: pending });
        if (withWorktree.length === 0) return;
        void safely(() => api.worktreeBlocked(withWorktree)).then((result) => {
          // 查不到时按没有处理：Main 删除时仍会拒绝未确认的，失败计入提示
          if (get().pendingRemoval !== pending) return;
          set({ pendingRemoval: { ...pending, blocked: result.ok ? result.sessionIds : [] } });
        });
      },

      confirmRemoveSessions(force = false) {
        const pending = get().pendingRemoval;
        if (!pending) return Promise.resolve({ done: 0, failed: 0 });
        set({ pendingRemoval: null });
        const blocked = new Set(pending.blocked);
        return runBulk(pending.workspaceId, pending.sessionIds, 'remove', (sessionId) =>
          blocked.has(sessionId) && !force
            ? Promise.resolve({ ok: false, error: translate('sessions.bulk.unmergedSkipped') })
            : get().removeSession(sessionId, force)
        );
      },

      cancelRemoveSessions() {
        set({ pendingRemoval: null });
      },

      archiveIdleSessions(workspaceId) {
        flushEvents();
        const state = get();
        const idle = (state.sessionsByWorkspace[workspaceId] ?? []).filter(
          (session) =>
            session.id !== state.activeSessionId &&
            !sending.has(session.id) &&
            !isBusy(statusOf(state, session.id))
        );
        return get().archiveSessions(
          workspaceId,
          idle.map((session) => session.id)
        );
      },

      async removeSession(sessionId, force) {
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
          recoveringCompaction: omitKey(before.recoveringCompaction, sessionId),
          stopping: omitKey(before.stopping, sessionId),
          drafts: omitKey(before.drafts, sessionId),
          draftImages: omitKey(before.draftImages, sessionId),
          draftFiles: omitKey(before.draftFiles, sessionId),
          queuedBySession: omitKey(before.queuedBySession, sessionId),
          messagesBySession: omitKey(before.messagesBySession, sessionId),
          runtimeBySession: omitKey(before.runtimeBySession, sessionId),
          pendingApprovals: omitKey(before.pendingApprovals, sessionId),
          loadingHistory: omitKey(before.loadingHistory, sessionId),
          ...(wasActive ? { activeSessionId: nextId } : {}),
          ...(before.modelPickerFor === sessionId ? { modelPickerFor: null } : {}),
        });
        if (wasActive && nextId) void get().selectSession(nextId);
        const result = await safely(() =>
          force ? api.remove(sessionId, { force }) : api.remove(sessionId)
        );
        if (result.ok) {
          modelSwitches.delete(sessionId);
          approvalSwitches.delete(sessionId);
          planSwitches.delete(sessionId);
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
          draftFiles: restore(state.draftFiles, before.draftFiles),
          queuedBySession: restore(state.queuedBySession, before.queuedBySession),
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
      // 只刷新看过的工作区；其余的等切过去时再拉。批量操作中的工作区由它结束时重拉一次
      if (
        !Object.hasOwn(state.bulkByWorkspace, workspaceId) &&
        (workspaceId === state.workspaceId || Object.hasOwn(state.sessionsByWorkspace, workspaceId))
      ) {
        void state.loadSessions(workspaceId);
      }
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
