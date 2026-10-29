import { randomUUID } from 'node:crypto';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import type {
  ApprovalMode,
  ContextRuntimeSnapshot,
  FynvraSessionEvent,
  FynvraSessionEventBody,
  Role,
  ThinkingLevel,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { supportsFastMode } from '@shared/modelFast';
import type {
  AgentApprovalRequest,
  AgentCommand,
  AgentMcpServer,
  AgentRoleOption,
  AgentWorkerEvent,
  HostCallResult,
  LogLevel,
  ModelQuery,
  ModelsDescribedResult,
  ResolvedModelSpec,
  SessionIdentity,
  SpawnSessionSpec,
} from '@shared/types/agent';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatImage,
  ChatMessage,
  ModelOptions,
  ModelThinkingCapability,
  ReplySuggestion,
  SessionEventEnvelope,
  SessionModelRef,
  SessionStatus,
  SessionSummary,
} from '@shared/types/chat';
import { normalizeReplySuggestion } from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { ModelEntry, ModelProviderView } from '@shared/types/llm';
import { type CompactionStrategy, compactionTimeoutMsOf } from '@shared/types/settings';
import type { Workspace } from '@shared/types/workspace';
import { translate } from '../../i18n';
import type { BranchTracker } from '../sessions/branches';
import { readHistory, sessionFilePath } from '../sessions/history';
import type { LastModelStore } from '../sessions/lastModels';
import { type SessionStore, type StoredSession, toSummary } from '../sessions/sessionStore';
import { invokeOrchestrationHost, invokeWorkerHost } from './hostDispatch';
import { Transcript } from './transcript';
import type { AgentHost, ModelRef, ModelResolver, WorkerSessionLauncher } from './types';
import { createWorkerClient, type WorkerClientOptions, type WorkerProcess } from './workerClient';

export interface RoleSource {
  get(id: string): Promise<Role | undefined>;
  list(): Promise<Role[]>;
}

export interface RoleResources {
  skills: string[];
  mcpServers: AgentMcpServer[];
  instructionFile?: SpawnSessionSpec['instructionFile'];
  /** 配置问题（如角色引用了已删除的技能 / MCP），spawn 时记进日志 */
  warnings: string[];
}

export interface AgentHostDeps {
  fork(): WorkerProcess;
  /** userData/agent：pi 的 agentDir，会话 jsonl 在它的 sessions/ 下 */
  agentDir: string;
  store: SessionStore;
  workspaces: { get(id: string): Workspace | undefined };
  roles: RoleSource;
  models: ModelResolver;
  /**
   * 「设置 → 模型服务」的脱敏视图（不带 key）：model-options 的列表，以及 spec 里模型条目的 reasoning 标记
   * （pi 目录外的模型靠它决定能不能思考）。缺省为空列表
   */
  providers?: { list(): Promise<readonly ModelProviderView[]> };
  /** 每个工作区上一次用过的模型（settings.json）；缺省不记 */
  lastModels?: LastModelStore;
  /** 会话 cwd 当前检出的分支（生产为 readGitBranch 加缓存与节流）；缺省时会话不带分支 */
  branches?: BranchTracker;
  /** 等 worker 回答 describe-models 的上限，默认 15 s */
  describeTimeoutMs?: number;
  /** Main → Renderer 推送（生产为 sendToAllWindows） */
  broadcast(channel: string, ...args: unknown[]): void;
  /** role.skillIds / mcpServerIds → 路径与服务器配置（生产为 createRoleResourceResolver）；缺省都为空 */
  resolveResources?(role: Role): Promise<RoleResources>;
  /** 会话 bash 工具用的 shell（生产为 createShellPathResolver）；缺省或返回 undefined 时由 pi 自己找 */
  resolveShellPath?(): Promise<string | undefined>;
  /** 上下文自动压缩策略（生产为 settings 的 preferences.compactionStrategy）；缺省 native */
  resolveCompactionStrategy?(): CompactionStrategy;
  resolveCompactionTimeoutMs?(): number;
  resolveNetworkProxy?(): SpawnSessionSpec['networkProxy'];
  workerOptions?: Pick<
    WorkerClientOptions,
    'readyTimeoutMs' | 'maxRestarts' | 'restartWindowMs' | 'restartDelayMs'
  >;
  log?(level: LogLevel, message: string): void;
  now?(): number;
  newId?(): string;
}

export interface CreateSessionInput {
  workspaceId: string;
  roleId: string;
  model?: SessionModelRef;
}

export interface SetModelInput {
  sessionId: string;
  model: SessionModelRef;
}

export interface SetApprovalModeInput {
  sessionId: string;
  mode: ApprovalMode;
}

export interface RespondApprovalInput {
  sessionId: string;
  requestId: string;
  decision: ApprovalDecision;
}

/** 旁路观察者（桌面通知用）：拿到的与推给 Renderer 的 sessions:event / sessions:approval-request 相同 */
export interface SessionObserver {
  event?(envelope: SessionEventEnvelope): void;
  approval?(request: ApprovalRequest): void;
  /** Main-only scheduling signals; automatic prompts do not emit `prompt`. */
  activity?(sessionId: string, action: 'prompt' | 'abort' | 'idle'): void;
}

/** AgentHost（§9.5）加上 sessions IPC 用到的会话操作 */
export interface AgentHostService extends AgentHost {
  /**
   * 派发出的 worker 会话以 Run 的主 agent 会话为 parentSessionId（launcher 入参只有 runId，
   * 此时 Dispatch 也还没写入）；由 orchestration 接线时注入，之前不设 parentSessionId。
   */
  setCoordinatorLookup(f: (workspaceId: string, runId: string) => string | undefined): void;
  start(): void;
  /** 关闭 worker（先让它关闭全部会话）并落盘注册表 */
  shutdown(timeoutMs: number): Promise<void>;
  list(workspaceId: string): SessionSummary[];
  create(input: CreateSessionInput): Promise<IpcResult<{ session: SessionSummary }>>;
  remove(sessionId: string): Promise<IpcResult>;
  /**
   * 发消息（首次使用时先在 worker 里 spawn）。images 是用户粘贴的图片，只来自 sessions:prompt；
   * 编排侧（任务书、打回反馈）只发文本。还没有标题的会话取这条的文本作标题，只有图片的消息不占用这次机会
   */
  prompt(sessionId: string, text: string, images?: ChatImage[]): Promise<IpcResult>;
  /** Automatic continuation: never queues behind a user turn or revives an archived session. */
  promptWhenIdle(sessionId: string, text: string): Promise<IpcResult<{ delivered: boolean }>>;
  /** Same as prompt, but while running the message steers the current turn (only from sessions:steer) */
  steer(sessionId: string, text: string, images?: ChatImage[]): Promise<IpcResult>;
  retryCompaction(sessionId: string): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  history(sessionId: string): Promise<
    IpcResult<{
      messages: ChatMessage[];
      contextRuntime?: ContextRuntimeSnapshot;
      contextRuntimeSeq?: number;
    }>
  >;
  respondApproval(input: RespondApprovalInput): Promise<IpcResult>;
  /**
   * 为刚正常结束的一轮生成一条输入框灰字建议（`roundId` = settled 事件的会话级 seq）。
   * 只接受当前空闲、未归档、没有待审批的会话；同一轮只请求一次（含空结果），并发有界，
   * 失败 / 超时 / 旧轮 / 旧 generation 一律返回空建议，不影响主对话
   */
  suggestReply(input: {
    sessionId: string;
    roundId: number;
  }): Promise<IpcResult<{ suggestion: ReplySuggestion | null }>>;
  /**
   * 换会话的模型 / 思考档位：解析成功后更新记录（落 sessions.json），会话在 worker 里时发 set-model，
   * 下一次 prompt 起生效。运行中拒绝；解析失败返回可读错误，记录不变。
   */
  setModel(input: SetModelInput): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 启用且有 key 的服务与模型，每个模型带 worker 按 pi 目录给出的思考档位；传 workspaceId 时带上次用过的模型 */
  modelOptions(input: { workspaceId?: string }): Promise<IpcResult<ModelOptions>>;
  /**
   * 换会话的审批档位：更新记录（落 sessions.json），会话在 worker 里时发 set-approval-mode。
   * 运行中也可以切（即时生效，这是与换模型的区别）；会话还没在 worker 里时只改记录，下次 spawn 用新值。
   */
  setApprovalMode(input: SetApprovalModeInput): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 窗口重新获得焦点：重读读过的会话目录的分支（节流），有变化的工作区广播 sessions:changed */
  refreshBranches(): void;
  /** 会话的 IPC 视图；不存在时 undefined */
  get(sessionId: string): SessionSummary | undefined;
  /** 订阅推给 Renderer 的会话事件与审批请求；观察者抛异常只记日志，不影响推送。返回取消订阅 */
  observe(observer: SessionObserver): () => void;
}

interface PendingCompactionRecovery {
  requestId: string;
  phase: 'loading' | 'requested';
  cancelled: boolean;
}

/** Main 侧每个会话的运行态（不落盘） */
interface LiveSession {
  contextRuntime?: ContextRuntimeSnapshot;
  contextRuntimeSeq?: number;
  recovery?: PendingCompactionRecovery;
  /** 最近一次 spawn 用的 generation；0 表示还没 spawn 过 */
  generation: number;
  /** spawn-session 已交给当前 worker 进程，且没有关闭 / 失败 */
  spawned: boolean;
  /** worker 崩溃时它在 worker 里：重启后重新 spawn */
  respawn: boolean;
  /** 最近一次 spawn 的参数（含 API key，只在 Main 内存里），崩溃重启时原样重发 */
  spec: SpawnSessionSpec | null;
  /** 当前 generation 已转发的最大 worker seq */
  workerSeq: number;
  /** 推给 Renderer 的会话级 seq：跨 generation 单调递增，Renderer 的「过期 seq 丢弃」在重启后依然成立 */
  sessionSeq: number;
  /** Warnings preserve suggestion validity but still participate in ordered delivery. */
  activitySeq: number;
  running: boolean;
  /** 还在途的 prompt（spawn / 发出之前）：这期间不能换模型，否则 spawn 用的还是旧模型 */
  prompting: number;
  /** Invalidates an automatic prompt when a user prompt/abort arrives during spawn. */
  activity: number;
  transcript: Transcript | null;
  /** 进行中的 host 调用：`<generation>:<callId>` → 中止器 */
  calls: Map<string, AbortController>;
  /** Bound lazily after initial dispatch registration, retained for the entire run */
  workerHost: WorkerHost | null;
  interruption?: string;
  lastError?: string;
  /** Invalidates queued fresh-attempt feedback on explicit stop/removal/crash */
  roundEpoch: number;
  /** 最近一次正常结束（非 aborted）的 agent_settled 的会话级 seq；新一轮开始 / 换模型时清 0 */
  lastSettledSeq: number;
  /** 当前 generation 里正常结束的回合数：与 worker 同步计数，用于双重核对轮次 */
  settledRounds: number;
  /** 最近一次已发起建议请求的 settled 轮次：同一轮不再请求（含空结果 / 失败） */
  suggestedRound: number;
}

interface PendingApproval {
  sessionId: string;
  generation: number;
  expiresAt: number;
}

interface PendingSuggestion {
  sessionId: string;
  generation: number;
  roundId: number;
  /** worker 侧的回合计数，回包必须原样带回 */
  round: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: Result<{ suggestion: ReplySuggestion | null }>): void;
}

type Result<T extends object = object> = IpcResult<T>;

const NO_ORCHESTRATION_HOST =
  'orchestration is not wired yet: this build has no OrchestrationHost for this session, so orchestration tools cannot run';
const NO_WORKER_HOST =
  'this session has no coordinator: it was not dispatched by an orchestrator, or the worker host is not wired yet';
const TITLE_MAX_CHARS = 60;
const DESCRIBE_TIMEOUT_MS = 15_000;
/** 建议请求的总上限：worker 自己 8 s 超时，这里多留一点收尾时间 */
const SUGGESTION_TIMEOUT_MS = 10_000;
/** 同时最多几条建议请求：辅助功能不能与主对话争资源 */
const MAX_CONCURRENT_SUGGESTIONS = 2;
/** dispatch_task 认不出模型时错误里最多列出的可选模型数 */
const MODEL_OPTIONS_SHOWN = 30;

/**
 * Main 侧的 agent 会话管理：
 * - 托管一个 agent worker 进程（workerClient：fork、ready 握手、崩溃重启）；
 * - 会话注册表在 sessions.json，正文在 pi jsonl；会话首次使用时才在 worker 里 spawn（新 generation）；
 * - worker 事件已由 workerClient 收窄，这里再丢弃过期 generation / 重复 seq，改写为会话级 seq 后推给 Renderer；
 * - 编排 / worker 工具的 host-invoke 交给注入的 OrchestrationHost / WorkerHost 工厂执行；
 * - 审批门的 approval-request 记为待审批并推给 Renderer，respondApproval 只回给提出请求的 generation；
 * - worker 崩溃后 generation+1 重新 spawn 崩溃前的会话，进行中的回合按中止处理。
 */
export function createAgentHost(deps: AgentHostDeps): AgentHostService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? defaultLog;
  const resolveResources =
    deps.resolveResources ??
    (async (): Promise<RoleResources> => ({ skills: [], mcpServers: [], warnings: [] }));
  const resolveShellPath = deps.resolveShellPath ?? (async () => undefined);
  const resolveCompactionStrategy = deps.resolveCompactionStrategy ?? (() => 'native' as const);
  const describeTimeoutMs = deps.describeTimeoutMs ?? DESCRIBE_TIMEOUT_MS;
  const live = new Map<string, LiveSession>();
  const approvals = new Map<string, PendingApproval>();
  /** 在途的建议请求：requestId → 结算；同时用它限制并发并丢弃旧回包 */
  const suggestions = new Map<string, PendingSuggestion>();
  let suggestionSeq = 0;
  let recoverySeq = 0;
  /** 模型的思考档位：pi 目录随 worker 版本固定，同一（协议, 模型, reasoning 标记）的回答不会变 */
  const capabilities = new Map<string, ModelThinkingCapability>();
  /** 等 worker 回答的 describe-models：requestId → 结算 */
  const describing = new Map<string, (result: ModelsDescribedResult) => void>();
  let describeSeq = 0;
  let orchestrationHostFor: (
    coordinatorSessionId: string,
    workspaceId: string
  ) => OrchestrationHost | null = () => null;
  let workerHostFor: (sessionId: string) => WorkerHost | null = () => null;
  let coordinatorOf: (workspaceId: string, runId: string) => string | undefined = () => undefined;
  const observers = new Set<SessionObserver>();
  const failureListeners = new Set<() => void>();
  const roundWaiters = new Set<() => void>();
  /** Removable queue entries preserve ordering when a waiting call is cancelled. */
  const roundQueue = new Map<string, Set<symbol>>();

  const wakeRounds = () => {
    for (const wake of [...roundWaiters]) wake();
  };
  function announceFailure(sessionId: string): void {
    for (const listener of failureListeners) {
      try {
        listener();
      } catch (error) {
        log('warn', `session ${sessionId} failure listener: ${errorMessage(error)}`);
      }
    }
  }
  function interrupted(sessionId: string, state: LiveSession, reason: string): void {
    state.interruption = reason;
    state.roundEpoch += 1;
    wakeRounds();
    announceFailure(sessionId);
  }

  const client = createWorkerClient({
    fork: deps.fork,
    onEvent: (event) => handleEvent(event),
    onStarted: () => respawnSessions(),
    onCrash: ({ code, willRestart }) => handleCrash(code, willRestart),
    log,
    ...deps.workerOptions,
  });

  function liveOf(sessionId: string): LiveSession {
    let state = live.get(sessionId);
    if (!state) {
      state = {
        generation: 0,
        spawned: false,
        respawn: false,
        spec: null,
        workerSeq: 0,
        sessionSeq: 0,
        activitySeq: 0,
        running: false,
        prompting: 0,
        activity: 0,
        transcript: null,
        calls: new Map(),
        workerHost: null,
        roundEpoch: 0,
        lastSettledSeq: 0,
        settledRounds: 0,
        suggestedRound: 0,
      };
      live.set(sessionId, state);
    }
    return state;
  }

  /** identity 是会话的当前 generation，且会话仍在 worker 里 */
  function currentOf(identity: SessionIdentity): LiveSession | undefined {
    const state = live.get(identity.sessionId);
    return state?.spawned && state.generation === identity.generation ? state : undefined;
  }

  function identityOf(sessionId: string, state: LiveSession): SessionIdentity {
    return { sessionId, generation: state.generation };
  }

  function changed(workspaceId: string): void {
    deps.broadcast(IPC_CHANNELS.SESSIONS_CHANGED, workspaceId);
  }

  /** 带上缓存里 cwd 的分支（没读过或不是 git 目录时不带） */
  function withBranch(summary: SessionSummary): SessionSummary {
    const branch = deps.branches?.get(summary.cwd);
    return branch ? { ...summary, branch } : summary;
  }

  /** IPC 视图：去掉内部字段，带上分支 */
  function summaryOf(stored: StoredSession): SessionSummary {
    const state = live.get(stored.id);
    return withBranch({
      ...toSummary(stored),
      ...(state?.contextRuntime
        ? { contextRuntime: state.contextRuntime, contextRuntimeSeq: state.contextRuntimeSeq }
        : {}),
    });
  }

  /**
   * 在后台重读这些目录的分支；分支有变化的目录所属的工作区各广播一次 sessions:changed，Renderer 重拉列表拿到新分支。
   * 读到的与缓存相同就不广播，重拉列表时的重读又落在节流窗口里，所以不会循环。
   */
  function rereadBranches(cwds: Iterable<string>, force = false): void {
    const branches = deps.branches;
    if (!branches) return;
    void branches
      .refresh(cwds, { force })
      .then((moved) => {
        if (moved.length === 0) return;
        const cwdsMoved = new Set(moved);
        const workspaceIds = new Set(
          deps.store
            .all()
            .filter((session) => cwdsMoved.has(session.cwd))
            .map((session) => session.workspaceId)
        );
        for (const workspaceId of workspaceIds) changed(workspaceId);
      })
      .catch((error: unknown) => log('warn', `读取会话分支失败：${errorMessage(error)}`));
  }

  function tellObservers(notify: (observer: SessionObserver) => void): void {
    for (const observer of observers) {
      try {
        notify(observer);
      } catch (error) {
        log('warn', `会话观察者出错：${errorMessage(error)}`);
      }
    }
  }

  function setStatus(sessionId: string, status: SessionStatus): void {
    wakeRounds();
    const stored = deps.store.get(sessionId);
    if (!stored || stored.status === status) return;
    deps.store.update(sessionId, { status, updatedAt: now() });
    changed(stored.workspaceId);
    if (status === 'idle') tellObservers((observer) => observer.activity?.(sessionId, 'idle'));
  }

  /** 推一条事件给 Renderer（同时进 transcript），seq 改写为会话级 */
  function deliver(sessionId: string, state: LiveSession, event: FynvraSessionEventBody): void {
    state.transcript?.append(event);
    state.sessionSeq += 1;
    if (!['warning', 'context_runtime', 'compaction', 'retry'].includes(event.type))
      state.activitySeq = state.sessionSeq;
    if (event.type === 'context_runtime') {
      state.contextRuntime = event.snapshot;
      state.contextRuntimeSeq = state.sessionSeq;
    }
    const envelope: SessionEventEnvelope = {
      sessionId,
      event: { ...event, seq: state.sessionSeq } as FynvraSessionEvent,
    };
    deps.broadcast(IPC_CHANNELS.SESSIONS_EVENT, envelope);
    tellObservers((observer) => observer.event?.(envelope));
  }

  /** 会话不再在 worker 里：中止它进行中的 host 调用，作废待审批请求，丢弃建议 */
  function detach(sessionId: string, state: LiveSession): void {
    state.spawned = false;
    state.contextRuntime = undefined;
    state.contextRuntimeSeq = undefined;
    state.recovery = undefined;
    state.running = false;
    state.lastSettledSeq = 0;
    state.suggestedRound = 0;
    cancelSuggestions(sessionId, false);
    for (const controller of state.calls.values()) controller.abort();
    state.calls.clear();
    for (const [requestId, pending] of approvals) {
      if (pending.sessionId === sessionId) approvals.delete(requestId);
    }
  }

  function send(command: AgentCommand): boolean {
    return client.send(command);
  }

  /** 结算一条建议请求：删表、清定时器，只结算一次 */
  function settleSuggestion(
    requestId: string,
    result: Result<{ suggestion: ReplySuggestion | null }>
  ): void {
    const pending = suggestions.get(requestId);
    if (!pending) return;
    suggestions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /**
   * 丢弃一个会话所有在途建议：立即结算为空（不阻塞调用方），并让 worker 中止请求。
   * 会话关闭 / 崩溃时 notifyWorker 为 false（worker 进程已经不在了）
   */
  function cancelSuggestions(sessionId: string, notifyWorker: boolean): void {
    for (const [requestId, pending] of suggestions) {
      if (pending.sessionId !== sessionId) continue;
      const command: AgentCommand = {
        type: 'cancel-suggestion',
        identity: { sessionId, generation: pending.generation },
        requestId,
      };
      if (notifyWorker) send(command);
      settleSuggestion(requestId, { ok: true, suggestion: null });
    }
  }

  /** 新轮 / 换模型 / 停止 / 删除：旧轮的建议不能再出现 */
  function invalidateSuggestion(sessionId: string, state: LiveSession): void {
    state.lastSettledSeq = 0;
    state.suggestedRound = 0;
    cancelSuggestions(sessionId, state.spawned);
  }

  function spawnWith(sessionId: string, state: LiveSession, spec: SpawnSessionSpec): boolean {
    state.generation += 1;
    state.workerSeq = 0;
    // worker 里的回合计数从 0 重新开始，Main 同步重置（建议请求的 round 要两边一致）
    state.settledRounds = 0;
    state.lastSettledSeq = 0;
    state.suggestedRound = 0;
    state.spec = spec;
    state.spawned = send({ type: 'spawn-session', identity: identityOf(sessionId, state), spec });
    return state.spawned;
  }

  async function buildSpec(stored: StoredSession): Promise<Result<{ spec: SpawnSessionSpec }>> {
    try {
      const role = await deps.roles.get(stored.roleId);
      if (!role) return fail(translate('agent.roleNotFound', { id: stored.roleId }));
      const resolved = await deps.models.resolve(stored.model ?? modelRefOf(role));
      if (!resolved.ok) return resolved;
      const model = withReasoning(resolved.model, await reasoningOf(resolved.ref));
      const resources = await resolveResources(role);
      for (const warning of resources.warnings) log('warn', `session ${stored.id}: ${warning}`);
      const roles = role.tools === 'orchestrator' ? roleOptions(await deps.roles.list()) : [];
      const shellPath = await resolveShellPath();
      const networkProxy = deps.resolveNetworkProxy?.();
      const compactionStrategy = resolveCompactionStrategy();
      // 普通目录（无 git）的工作区编排原地进行：提示词按此追加说明、换 worker 契约
      const inPlace = deps.workspaces.get(stored.workspaceId)?.vcs === 'none';
      return {
        ok: true,
        spec: {
          // 审批门按会话自己的档位建（创建时取自角色，之后可能被用户切过）
          role: { ...role, approvalMode: stored.approvalMode },
          cwd: stored.cwd,
          sessionFile: sessionFilePath(deps.agentDir, stored.id),
          model,
          skills: resources.skills,
          ...(resources.instructionFile ? { instructionFile: resources.instructionFile } : {}),
          mcpServers: resources.mcpServers,
          worker: stored.dispatchId !== undefined,
          roles,
          ...(networkProxy ? { networkProxy } : {}),
          ...(shellPath ? { shellPath } : {}),
          ...(compactionStrategy !== 'native' ? { compactionStrategy } : {}),
          compactionTimeoutMs: compactionTimeoutMsOf({
            compactionTimeoutMs: deps.resolveCompactionTimeoutMs?.(),
          }),
          ...(inPlace ? { inPlace: true } : {}),
        },
      };
    } catch (error) {
      return fail(translate('agent.startFailed', { error: errorMessage(error) }));
    }
  }

  async function providerViews(): Promise<readonly ModelProviderView[]> {
    return (await deps.providers?.list()) ?? [];
  }

  /** 设置里模型条目的 reasoning 标记；读不到注册表时不带（worker 按 pi 目录或不推理处理） */
  async function reasoningOf(ref: { providerId: string; modelId: string }) {
    try {
      const provider = (await providerViews()).find((view) => view.id === ref.providerId);
      return provider?.models.find((model) => model.id === ref.modelId)?.reasoning;
    } catch {
      return undefined;
    }
  }

  /**
   * dispatch_task 的 model 参数 → 设置里的模型：按 modelId（不区分大小写）或 providerId/modelId 匹配，
   * 只看启用且有 key 的服务。认不出或有歧义时报错并列出可选项（只有 id，不带 key）。
   */
  async function pickModel(wanted: string): Promise<Result<{ ref: ModelRef }>> {
    let views: readonly ModelProviderView[];
    try {
      views = await providerViews();
    } catch (error) {
      return fail(translate('providers.readFailed', { error: errorMessage(error) }));
    }
    const options = views
      .filter((view) => view.enabled && view.hasApiKey)
      .flatMap((view) => view.models.map((entry) => ({ providerId: view.id, modelId: entry.id })));
    const key = wanted.trim().toLowerCase();
    const matches = options.filter(
      (option) =>
        option.modelId.toLowerCase() === key || qualifiedModelId(option).toLowerCase() === key
    );
    const [only] = matches;
    if (only && matches.length === 1) return { ok: true, ref: only };
    const listed = (matches.length > 1 ? matches : options).map(qualifiedModelId);
    const more =
      listed.length > MODEL_OPTIONS_SHOWN
        ? `, … (${listed.length - MODEL_OPTIONS_SHOWN} more)`
        : '';
    const shown = `${listed.slice(0, MODEL_OPTIONS_SHOWN).join(', ')}${more}`;
    if (matches.length > 1) {
      return fail(`model "${wanted}" is ambiguous; use providerId/modelId: ${shown}`);
    }
    return fail(
      listed.length > 0
        ? `unknown model "${wanted}"; available: ${shown}`
        : `unknown model "${wanted}"; no models are configured`
    );
  }

  /** 派发时指定的思考档位必须在模型支持的档位里（不支持推理的模型只接受 off） */
  async function checkThinking(ref: ModelRef, thinking: ThinkingLevel): Promise<Result> {
    let views: readonly ModelProviderView[];
    try {
      views = await providerViews();
    } catch (error) {
      return fail(translate('providers.readFailed', { error: errorMessage(error) }));
    }
    const view = views.find((candidate) => candidate.id === ref.providerId);
    const entry = view?.models.find((candidate) => candidate.id === ref.modelId);
    const name = qualifiedModelId(ref);
    if (!view || !entry) {
      return fail(`cannot check thinking levels of ${name}: it is not in the configured models`);
    }
    const described = await describeModels([queryOf(view, entry)]);
    if (!described.ok) return described;
    const levels = described.models[0]?.thinkingLevels ?? [];
    if (levels.includes(thinking) || (levels.length === 0 && thinking === 'off')) {
      return { ok: true };
    }
    return fail(
      levels.length > 0
        ? `model ${name} does not support thinking "${thinking}"; supported: ${levels.join(', ')}`
        : `model ${name} does not support thinking levels; omit thinking`
    );
  }

  /** 问 worker（pi 内置目录）每个模型的思考档位；问过的从缓存取，结果与 queries 一一对应 */
  async function describeModels(
    queries: ModelQuery[]
  ): Promise<Result<{ models: ModelThinkingCapability[] }>> {
    const missing = new Map<string, ModelQuery>();
    for (const query of queries) {
      const key = capabilityKey(query);
      if (!capabilities.has(key)) missing.set(key, query);
    }
    if (missing.size > 0) {
      const asked = [...missing.values()];
      const answer = await askWorker(asked);
      if (!answer.ok) return answer;
      if (answer.models.length !== asked.length) {
        return fail(translate('agent.describeMismatch'));
      }
      asked.forEach((query, index) => {
        const capability = answer.models[index];
        if (capability) capabilities.set(capabilityKey(query), capability);
      });
    }
    return {
      ok: true,
      models: queries.map((query) => {
        const capability = capabilities.get(capabilityKey(query)) ?? { thinkingLevels: [] };
        return { ...capability, thinkingLevels: [...capability.thinkingLevels] };
      }),
    };
  }

  function askWorker(models: ModelQuery[]): Promise<ModelsDescribedResult> {
    if (client.state === 'stopped') client.start();
    const requestId = `describe-${++describeSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle(fail(translate('agent.describeTimeout'))),
        describeTimeoutMs
      );
      const settle = (result: ModelsDescribedResult) => {
        clearTimeout(timer);
        describing.delete(requestId);
        resolve(result);
      };
      describing.set(requestId, settle);
      if (!send({ type: 'describe-models', requestId, models }))
        settle(fail(translate('agent.workerUnavailable')));
    });
  }

  function failDescribes(error: string): void {
    for (const settle of [...describing.values()]) settle(fail(error));
  }

  /** 正在跑一轮、等审批，或有 prompt 在途：这时换模型，spawn / 当前回合用的就对不上记录了 */
  function isBusy(stored: StoredSession): boolean {
    const state = live.get(stored.id);
    return (
      stored.status === 'running' ||
      stored.status === 'waiting-approval' ||
      state?.running === true ||
      state?.recovery !== undefined ||
      (state?.prompting ?? 0) > 0
    );
  }

  async function loadTranscript(stored: StoredSession): Promise<Transcript> {
    const file = sessionFilePath(deps.agentDir, stored.id);
    return Transcript.fromMessages(await readHistory(file, stored.id).catch(() => []));
  }

  async function ensureTranscript(stored: StoredSession, state: LiveSession): Promise<Transcript> {
    if (!state.transcript) {
      const transcript = await loadTranscript(stored);
      // 并发的调用可能已经初始化并开始追加实时事件，不能覆盖
      state.transcript ??= transcript;
    }
    return state.transcript;
  }

  /** 会话首次使用（或 worker 丢了它）时在 worker 里创建；transcript 先从 jsonl 初始化，再接实时事件 */
  async function ensureSpawned(
    stored: StoredSession,
    wanted: () => boolean = () => true
  ): Promise<Result> {
    const state = liveOf(stored.id);
    if (state.spawned) return { ok: true };
    if (client.state === 'stopped') client.start();
    if (client.state !== 'starting' && client.state !== 'ready')
      return fail(translate('agent.workerUnavailable'));
    const built = await buildSpec(stored);
    if (!built.ok) return built;
    await ensureTranscript(stored, state);
    if (!deps.store.get(stored.id)) return fail(translate('common.sessionNotFound'));
    if (!wanted()) return fail('Compaction recovery was cancelled.');
    if (state.spawned) return { ok: true };
    return spawnWith(stored.id, state, built.spec)
      ? { ok: true }
      : fail(translate('agent.workerUnavailable'));
  }

  function finishRecovery(
    sessionId: string,
    state: LiveSession,
    operation: PendingCompactionRecovery,
    result: Result
  ): void {
    if (state.recovery !== operation) return;
    state.recovery = undefined;
    state.running = false;
    if (operation.cancelled) {
      setStatus(sessionId, 'idle');
    } else if (!result.ok) {
      if (state.lastError !== result.error)
        deliver(sessionId, state, { type: 'error', source: 'compaction', message: result.error });
      state.lastError = result.error;
      setStatus(sessionId, 'error');
    } else {
      setStatus(
        sessionId,
        state.contextRuntime?.recoveryRequired || deps.store.get(sessionId)?.status === 'error'
          ? 'error'
          : 'idle'
      );
    }
  }

  async function startRecovery(
    stored: StoredSession,
    state: LiveSession,
    operation: PendingCompactionRecovery
  ): Promise<void> {
    const wanted = () => state.recovery === operation && !operation.cancelled;
    try {
      if (client.state === 'restarting') client.start();
      const spawned = await ensureSpawned(stored, wanted);
      if (!wanted()) return;
      if (!spawned.ok) {
        finishRecovery(stored.id, state, operation, spawned);
        return;
      }
      operation.phase = 'requested';
      if (
        !send({
          type: 'retry-compaction',
          identity: identityOf(stored.id, state),
          requestId: operation.requestId,
        })
      ) {
        finishRecovery(stored.id, state, operation, fail(translate('agent.workerUnavailable')));
      }
    } catch (error) {
      if (wanted()) finishRecovery(stored.id, state, operation, fail(errorMessage(error)));
    }
  }

  function handleEvent(event: Exclude<AgentWorkerEvent, { type: 'ready' }>): void {
    switch (event.type) {
      case 'compaction-recovery-result': {
        const state = currentOf(event.identity);
        const operation = state?.recovery;
        if (!state || !operation || operation.requestId !== event.requestId) return;
        finishRecovery(event.identity.sessionId, state, operation, event.result);
        return;
      }
      case 'session-event': {
        const state = currentOf(event.identity);
        // 过期 generation、重复或乱序的 seq 一律丢弃
        if (!state || event.seq <= state.workerSeq) return;
        state.workerSeq = event.seq;
        const { sessionId } = event.identity;
        if (event.event.type === 'error') state.lastError = event.event.message;
        if (event.event.type === 'agent_settled' && event.event.aborted) {
          interrupted(sessionId, state, 'Worker attempt interrupted: the agent run was aborted');
          state.lastSettledSeq = 0;
          cancelSuggestions(sessionId, state.spawned);
        }
        deliver(sessionId, state, event.event);
        if (event.event.type === 'agent_settled') {
          // 不再有进行中的回合：状态事件可能稍后才到，建议请求不必等它
          state.running = false;
          if (!event.event.aborted) {
            state.lastSettledSeq = state.sessionSeq;
            state.settledRounds += 1;
          }
          for (const [requestId, pending] of approvals) {
            if (pending.sessionId === sessionId) approvals.delete(requestId);
          }
          // 这一轮里 agent 可能切过分支：不等节流，重读一次
          const stored = deps.store.get(sessionId);
          if (stored) rereadBranches([stored.cwd], true);
        }
        return;
      }
      case 'session-status': {
        const state = currentOf(event.identity);
        if (!state) return;
        state.running = event.status === 'running' || event.status === 'waiting-approval';
        if (event.status === 'error') {
          interrupted(
            event.identity.sessionId,
            state,
            `Worker attempt interrupted: ${state.lastError ?? 'the agent run ended with an error'}`
          );
        }
        setStatus(event.identity.sessionId, event.status);
        return;
      }
      case 'host-invoke':
        void runHostCall(event);
        return;
      case 'host-cancel':
        currentOf(event.identity)
          ?.calls.get(`${event.identity.generation}:${event.callId}`)
          ?.abort();
        return;
      case 'approval-request':
        // 过期 generation 的请求没有人在等，不推给 Renderer
        if (!currentOf(event.identity)) return;
        announceApproval(event.identity, event.request);
        return;
      case 'session-error': {
        const state = currentOf(event.identity);
        if (!state) return;
        const { sessionId } = event.identity;
        state.lastError = event.error;
        state.lastSettledSeq = 0;
        cancelSuggestions(sessionId, false);
        if (event.fatal) {
          detach(sessionId, state);
          interrupted(sessionId, state, `Worker attempt interrupted: ${event.error}`);
        }
        deliver(sessionId, state, { type: 'error', source: 'host', message: event.error });
        setStatus(sessionId, 'error');
        return;
      }
      case 'suggestion-result': {
        const pending = suggestions.get(event.requestId);
        const { sessionId, generation } = event.identity;
        // requestId / generation / 会话 / 轮次任一对不上就是过期回包
        if (
          !pending ||
          pending.sessionId !== sessionId ||
          pending.generation !== generation ||
          pending.roundId !== event.roundId ||
          pending.round !== event.round
        ) {
          return;
        }
        const stored = deps.store.get(sessionId);
        const state = live.get(sessionId);
        const text = normalizeReplySuggestion(event.text);
        const current =
          stored !== undefined &&
          stored.archivedAt === undefined &&
          stored.status !== 'error' &&
          state !== undefined &&
          state.lastSettledSeq === event.roundId &&
          state.activitySeq === event.roundId &&
          state.settledRounds === event.round &&
          !state.running;
        settleSuggestion(event.requestId, {
          ok: true,
          suggestion: current && text ? { sessionId, roundId: event.roundId, text } : null,
        });
        return;
      }
      case 'models-described':
        describing.get(event.requestId)?.(event.result);
        return;
      case 'log':
        log(event.level, `[agent] ${event.message}`);
        return;
    }
  }

  async function runHostCall(event: Extract<AgentWorkerEvent, { type: 'host-invoke' }>) {
    const { identity, callId, kind, method, input } = event;
    const state = currentOf(identity);
    const stored = deps.store.get(identity.sessionId);
    // 过期 generation 的调用不执行：不能替已关闭的会话派活或合并
    if (!state || !stored) return;
    const key = `${identity.generation}:${callId}`;
    const controller = new AbortController();
    state.calls.set(key, controller);
    let result: HostCallResult;
    try {
      if (kind === 'orchestration') {
        const host = orchestrationHostFor(stored.id, stored.workspaceId);
        result = host
          ? await invokeOrchestrationHost(host, method, input, controller.signal)
          : fail(NO_ORCHESTRATION_HOST);
      } else {
        // Never rebind an old run to a retry inserted while report_done is returning.
        if (stored.dispatchId !== undefined) state.workerHost ??= workerHostFor(stored.id);
        const host = state.workerHost;
        result = host
          ? await invokeWorkerHost(host, method, input, controller.signal)
          : fail(NO_WORKER_HOST);
      }
    } catch (error) {
      result = fail(errorMessage(error));
    } finally {
      state.calls.delete(key);
    }
    // 等待期间 worker 可能已重启或会话已关闭：旧调用的结果不发给新进程
    if (currentOf(identity) !== state) return;
    const command: AgentCommand = { type: 'host-result', identity, callId, result };
    if (!send(command) && result.ok) {
      // 结果无法跨进程传递（如带函数）时至少让工具拿到错误，而不是等到超时
      send({ ...command, result: fail(`${method} returned a result that cannot be delivered`) });
    }
  }

  /** 审批门的请求：记为待审批，推给 Renderer 的审批条（kind / 标题 / 详情 / 到期时间以 worker 为准） */
  function announceApproval(identity: SessionIdentity, request: AgentApprovalRequest): void {
    const { sessionId, generation } = identity;
    const { requestId, kind, title, detail, protectedAction, expiresAt } = request;
    approvals.set(requestId, { sessionId, generation, expiresAt });
    const pushed: ApprovalRequest = {
      id: requestId,
      sessionId,
      kind,
      title: protectedAction
        ? translate('agent.protectedTitle', { title, action: protectedAction })
        : title,
      detail,
      expiresAt,
    };
    deps.broadcast(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST, pushed);
    tellObservers((observer) => observer.approval?.(pushed));
  }

  function handleCrash(code: number, willRestart: boolean): void {
    failDescribes(translate('agent.describeCrashed', { code }));
    for (const [sessionId, state] of live) {
      if (!state.spawned) continue;
      const wasRunning = state.running;
      detach(sessionId, state);
      state.respawn = willRestart;
      if (!wasRunning) continue;
      interrupted(
        sessionId,
        state,
        `Worker attempt interrupted: the agent process exited (code ${code})`
      );
      deliver(sessionId, state, {
        type: 'error',
        source: 'host',
        message: willRestart
          ? translate('agent.crashedRestarting', { code })
          : translate('agent.crashedStopped', { code }),
      });
      deliver(sessionId, state, { type: 'agent_settled', aborted: true });
      setStatus(sessionId, 'error');
    }
  }

  /** worker（重新）启动后、任何排队命令之前：为崩溃前在 worker 里的会话重发 spawn（generation+1） */
  function respawnSessions(): void {
    for (const [sessionId, state] of live) {
      if (!state.respawn) continue;
      state.respawn = false;
      if (state.spec && deps.store.get(sessionId)) {
        spawnWith(sessionId, state, {
          ...state.spec,
          networkProxy: deps.resolveNetworkProxy?.(),
        });
      }
    }
  }

  function prompt(sessionId: string, text: string, images?: ChatImage[]): Promise<Result> {
    return deliverMessage('prompt', sessionId, text, images);
  }

  function steer(sessionId: string, text: string, images?: ChatImage[]): Promise<Result> {
    return deliverMessage('steer', sessionId, text, images);
  }

  async function promptWhenIdle(
    sessionId: string,
    text: string
  ): Promise<Result<{ delivered: boolean }>> {
    const stored = deps.store.get(sessionId);
    if (!stored) return fail(translate('common.sessionNotFound'));
    if (
      stored.status !== 'idle' ||
      stored.archivedAt !== undefined ||
      isBusy(stored) ||
      live.get(sessionId)?.contextRuntime?.recoveryRequired
    ) {
      return { ok: true, delivered: false };
    }
    const state = liveOf(sessionId);
    const activity = state.activity;
    // 自动继续也算新一轮：旧轮的建议不能再出现 / 返回
    invalidateSuggestion(sessionId, state);
    state.prompting += 1;
    try {
      const spawned = await ensureSpawned(stored);
      if (!spawned.ok) return spawned;
      const current = deps.store.get(sessionId);
      // Spawn can await model/resources/history. Recheck after all awaits so a user turn wins.
      if (
        current?.status !== 'idle' ||
        current.archivedAt !== undefined ||
        state.activity !== activity ||
        state.running ||
        state.prompting > 1
      ) {
        return { ok: true, delivered: false };
      }
      if (!send({ type: 'prompt', identity: identityOf(sessionId, state), text })) {
        return fail(translate('agent.workerUnavailable'));
      }
      state.running = true;
      setStatus(sessionId, 'running');
      return { ok: true, delivered: true };
    } finally {
      state.prompting -= 1;
    }
  }

  /**
   * 在 Renderer 已确认输入框空闲、没有队列 / 待审批 / 图片 / 草稿之后，为刚结束的一轮生成建议。
   * 这里再核对 Main 记录的会话状态与轮次；worker 还会在生成前后核对自己的空闲状态与 generation。
   * 任何失败、超时、旧轮都返回空建议，不向 Renderer 抛错
   */
  async function suggestReply({
    sessionId,
    roundId,
  }: {
    sessionId: string;
    roundId: number;
  }): Promise<Result<{ suggestion: ReplySuggestion | null }>> {
    const empty: Result<{ suggestion: ReplySuggestion | null }> = {
      ok: true,
      suggestion: null,
    };
    const stored = deps.store.get(sessionId);
    if (!stored || stored.archivedAt !== undefined) return empty;
    // 状态事件可能比 Renderer 的请求晚到：真正权威的是本轮 settled 的 seq 与运行态；
    // 错误 / 等审批永远不生成
    if (stored.status === 'error' || stored.status === 'waiting-approval') return empty;
    const state = live.get(sessionId);
    if (!state?.spawned || state.running || state.prompting > 0) return empty;
    if (state.lastSettledSeq !== roundId || state.activitySeq !== roundId) return empty;
    const round = state.settledRounds;
    if (round <= 0) return empty;
    // 每轮只发起一次，空结果 / 失败也算（避免 Renderer 重渲染时反复请求）
    if (state.suggestedRound === roundId) return empty;
    if (suggestions.size >= MAX_CONCURRENT_SUGGESTIONS) return empty;
    for (const pending of approvals.values()) {
      if (pending.sessionId === sessionId) return empty;
    }

    const requestId = `suggest-${++suggestionSeq}`;
    const identity = identityOf(sessionId, state);
    state.suggestedRound = roundId;
    const answer = new Promise<Result<{ suggestion: ReplySuggestion | null }>>((resolve) => {
      const timer = setTimeout(() => {
        send({ type: 'cancel-suggestion', identity, requestId });
        settleSuggestion(requestId, empty);
      }, SUGGESTION_TIMEOUT_MS);
      suggestions.set(requestId, {
        sessionId,
        generation: identity.generation,
        roundId,
        round,
        timer,
        resolve,
      });
    });
    if (!send({ type: 'suggest-reply', identity, requestId, roundId, round })) {
      settleSuggestion(requestId, empty);
    }
    return answer;
  }

  async function deliverMessage(
    type: 'prompt' | 'steer',
    sessionId: string,
    text: string,
    images?: ChatImage[],
    freshRound = false,
    signal?: AbortSignal
  ): Promise<Result> {
    if (signal?.aborted) return fail('feedback delivery was aborted');
    const stored = deps.store.get(sessionId);
    if (!stored) return fail(translate('common.sessionNotFound'));
    const pending = liveOf(sessionId);
    if (pending.recovery || pending.contextRuntime?.recoveryRequired)
      return fail(translate('agent.compactionRecoveryRequired'));
    // 用户开始新一轮（或插话）：旧轮的建议立即作废，worker 里的在途请求也中止
    invalidateSuggestion(sessionId, pending);
    const epoch = pending.roundEpoch;
    pending.activity += 1;
    tellObservers((observer) => observer.activity?.(sessionId, 'prompt'));
    pending.prompting += 1;
    try {
      const spawned = await ensureSpawned(stored);
      if (signal?.aborted) return fail('feedback delivery was aborted');
      if (!spawned.ok) return spawned;
      const state = liveOf(sessionId);
      if (freshRound && (state.roundEpoch !== epoch || !deps.store.get(sessionId))) {
        return fail('the worker was interrupted before feedback delivery');
      }
      if (freshRound && (state.running || pending.prompting > 1)) {
        return fail(
          'the worker started another run before feedback delivery; retry the instruction'
        );
      }
      const identity = identityOf(sessionId, state);
      if (!send({ type, identity, text, ...(images?.length ? { images } : {}) })) {
        return fail(translate('agent.workerUnavailable'));
      }
      if (!state.running) {
        state.workerHost = null;
        state.interruption = undefined;
        state.lastError = undefined;
      }
      state.running = true;
      const current = deps.store.get(sessionId) ?? stored;
      // 只有图片（文本取不出标题）的消息不占用自动标题，留给下一条有文字的
      const title = current.autoTitle ? titleFrom(text) : '';
      deps.store.update(sessionId, {
        status: 'running',
        updatedAt: now(),
        ...(title ? { title, autoTitle: false } : {}),
      });
      changed(stored.workspaceId);
      return { ok: true };
    } finally {
      pending.prompting -= 1;
      wakeRounds();
    }
  }

  /** pi followUp stays in the old run; keep fresh-attempt feedback in Main until it really ends. */
  async function promptWorkerRound(
    sessionId: string,
    text: string,
    signal?: AbortSignal
  ): Promise<Result> {
    if (signal?.aborted) return fail('feedback delivery was aborted');
    const state = liveOf(sessionId);
    const epoch = state.roundEpoch;
    const queue = roundQueue.get(sessionId) ?? new Set<symbol>();
    const turn = Symbol();
    queue.add(turn);
    roundQueue.set(sessionId, queue);
    try {
      for (;;) {
        if (signal?.aborted) return fail('feedback delivery was aborted');
        const stored = deps.store.get(sessionId);
        if (!stored) return fail(translate('common.sessionNotFound'));
        if (state.roundEpoch !== epoch)
          return fail('the worker was interrupted before feedback delivery');
        if (queue.values().next().value === turn && !isBusy(stored)) break;
        await new Promise<void>((resolve) => {
          const wake = () => {
            roundWaiters.delete(wake);
            signal?.removeEventListener('abort', wake);
            resolve();
          };
          roundWaiters.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
        });
      }
      return await deliverMessage('prompt', sessionId, text, undefined, true, signal);
    } finally {
      queue.delete(turn);
      if (queue.size === 0) roundQueue.delete(sessionId);
      wakeRounds();
    }
  }

  /**
   * 换模型：记录（sessions.json）是权威，会话在 worker 里时再发 set-model；之后崩溃重启按新 spec 重建。
   * 两段 await（解析、读 reasoning 标记）之后再查一次：这期间会话可能被删了或开始了新一轮。
   */
  async function setModel({
    sessionId,
    model,
  }: SetModelInput): Promise<Result<{ session: SessionSummary }>> {
    const stored = deps.store.get(sessionId);
    if (!stored) return fail(translate('common.sessionNotFound'));
    if (isBusy(stored)) return fail(translate('agent.switchWhileRunning'));
    const resolved = await deps.models.resolve(bareRef(model));
    if (!resolved.ok) return resolved;
    const reasoning = await reasoningOf(resolved.ref);
    const current = deps.store.get(sessionId);
    if (!current) return fail(translate('common.sessionNotFound'));
    if (isBusy(current)) return fail(translate('agent.switchWhileRunning'));

    const next = sessionModelOf(resolved.ref, model.thinking, resolved.model.fastMode);
    const updated =
      deps.store.update(sessionId, {
        model: next,
        updatedAt: now(),
        // 换模型常是为了绕开上一轮的错误（如 key 失效）：回到空闲
        ...(current.status === 'error' ? { status: 'idle' as const } : {}),
      }) ?? current;
    const state = live.get(sessionId);
    if (state) invalidateSuggestion(sessionId, state);
    // 缓存的 spawn spec 一并改掉（含崩溃后等着重建的会话），重建时不会退回旧模型
    const spec = withReasoning(withThinking(resolved.model, next.thinking), reasoning);
    if (state?.spec) state.spec = { ...state.spec, model: spec };
    if (state?.spawned) {
      // 发不出去（worker 正在退出）：会话不再算在 worker 里，下次使用前按新记录重新 spawn
      if (!send({ type: 'set-model', identity: identityOf(sessionId, state), model: spec })) {
        detach(sessionId, state);
      }
    }
    if (current.dispatchId === undefined) deps.lastModels?.set(current.workspaceId, next);
    changed(current.workspaceId);
    return { ok: true, session: summaryOf(updated) };
  }

  /**
   * 换审批档位：记录（sessions.json）是权威。缓存的 spawn spec 一并改掉（含崩溃后等着重建的会话），
   * 重建时不会退回旧档位；会话在 worker 里时再发 set-approval-mode，不论是否在跑。
   */
  async function setApprovalMode({
    sessionId,
    mode,
  }: SetApprovalModeInput): Promise<Result<{ session: SessionSummary }>> {
    const stored = deps.store.get(sessionId);
    if (!stored) return fail(translate('common.sessionNotFound'));
    if (stored.approvalMode === mode) return { ok: true, session: summaryOf(stored) };
    const updated =
      deps.store.update(sessionId, { approvalMode: mode, updatedAt: now() }) ?? stored;
    const state = live.get(sessionId);
    if (state?.spec) {
      state.spec = { ...state.spec, role: { ...state.spec.role, approvalMode: mode } };
    }
    if (state?.spawned) {
      const identity = identityOf(sessionId, state);
      // 发不出去（worker 正在退出）：会话不再算在 worker 里，下次使用前按新记录重新 spawn
      if (!send({ type: 'set-approval-mode', identity, mode })) detach(sessionId, state);
    }
    changed(stored.workspaceId);
    return { ok: true, session: summaryOf(updated) };
  }

  async function modelOptions({
    workspaceId,
  }: {
    workspaceId?: string;
  }): Promise<Result<ModelOptions>> {
    let views: readonly ModelProviderView[];
    try {
      views = await providerViews();
    } catch (error) {
      return fail(translate('providers.readFailed', { error: errorMessage(error) }));
    }
    const usable = views.filter((view) => view.enabled && view.hasApiKey && view.models.length > 0);
    const queries = usable.flatMap((view) => view.models.map((entry) => queryOf(view, entry)));
    const described = await describeModels(queries);
    if (!described.ok) return described;
    let index = 0;
    const providers = usable.map((view) => ({
      providerId: view.id,
      name: view.name,
      api: view.api,
      models: view.models.map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(described.models[index++] ?? { thinkingLevels: [] }),
      })),
    }));
    const lastUsed = workspaceId ? deps.lastModels?.get(workspaceId) : undefined;
    return { ok: true, providers, ...(lastUsed ? { lastUsed } : {}) };
  }

  function disposeLive(sessionId: string): void {
    const state = live.get(sessionId);
    if (state) {
      state.activity += 1;
      state.roundEpoch += 1;
      wakeRounds();
    }
    tellObservers((observer) => observer.activity?.(sessionId, 'abort'));
    if (!state?.spawned) return;
    send({ type: 'dispose-session', identity: identityOf(sessionId, state) });
    const wasRunning = state.running;
    detach(sessionId, state);
    if (!wasRunning) return;
    // worker 关闭会话时按 deny 结束待审批、不再发事件：这里替它收尾，Renderer 据此清掉审批条
    deliver(sessionId, state, { type: 'agent_settled', aborted: true });
    setStatus(sessionId, 'idle');
  }

  async function remove(sessionId: string): Promise<Result> {
    const stored = deps.store.get(sessionId);
    if (!stored) return fail(translate('common.sessionNotFound'));
    disposeLive(sessionId);
    live.delete(sessionId);
    // 只删注册表记录；pi jsonl 保留（会话正文的权威源，误删可从文件恢复）
    deps.store.remove(sessionId);
    wakeRounds();
    announceFailure(sessionId);
    changed(stored.workspaceId);
    return { ok: true };
  }

  const launcher: WorkerSessionLauncher = {
    async createWorkerSession(input) {
      if (!deps.workspaces.get(input.workspaceId))
        return fail(translate('common.workspaceNotFound'));
      let role: Role | undefined;
      try {
        role = await deps.roles.get(input.roleId);
      } catch (error) {
        return fail(errorMessage(error));
      }
      if (!role) return fail(translate('agent.roleNotFound', { id: input.roleId }));
      const parentSessionId = coordinatorOf(input.workspaceId, input.runId);
      // 派发时指定的模型优先；否则角色配了模型用角色的；没配就跟主 agent 当前的模型、思考档位与 Fast
      let requested: SessionModelRef | undefined;
      if (input.model !== undefined) {
        const picked = await pickModel(input.model);
        if (!picked.ok) return picked;
        requested = picked.ref;
      } else {
        requested =
          modelRefOf(role) ??
          (parentSessionId ? deps.store.get(parentSessionId)?.model : undefined);
      }
      const resolved = await deps.models.resolve(requested && bareRef(requested));
      if (!resolved.ok) return resolved;
      if (input.thinking !== undefined) {
        const supported = await checkThinking(resolved.ref, input.thinking);
        if (!supported.ok) return supported;
      }
      // 模型落定后覆盖 Fast（包括没有角色 / 主会话模型的默认分支）；false 明确关闭继承。
      // 只存协议允许的值，随后 buildSpec 从会话记录解析最终 spec，不支持时仍用同一模型。
      const fastMode =
        (input.fastMode ?? resolved.model.fastMode) === true &&
        supportsFastMode(resolved.model.api);
      const time = now();
      const stored: StoredSession = {
        id: newId(),
        workspaceId: input.workspaceId,
        roleId: role.id,
        title: titleFrom(input.brief) || role.name,
        cwd: input.cwd,
        // 普通目录的尝试没有 worktree
        ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        dispatchId: input.dispatchId,
        status: 'idle',
        createdAt: time,
        updatedAt: time,
        model: sessionModelOf(resolved.ref, input.thinking ?? requested?.thinking, fastMode),
        // 权限随主 agent：按派发时主 agent 会话的当前档位（用户可能切过）；没有主 agent 时才用角色自己的
        approvalMode:
          (parentSessionId ? deps.store.get(parentSessionId)?.approvalMode : undefined) ??
          role.approvalMode,
      };
      deps.store.put(stored);
      changed(stored.workspaceId);
      // 第一条 prompt 就是任务书
      const prompted = await prompt(stored.id, input.brief);
      if (!prompted.ok) {
        await remove(stored.id);
        return prompted;
      }
      return { ok: true, sessionId: stored.id };
    },
    async promptSession(sessionId, text, options) {
      const result = options?.freshAttempt
        ? await promptWorkerRound(sessionId, text, options.signal)
        : await prompt(sessionId, text);
      return result.ok ? { ok: true } : result;
    },
    async readTranscript(sessionId, cursor) {
      const stored = deps.store.get(sessionId);
      if (!stored) return fail(translate('common.sessionNotFound'));
      const state = liveOf(sessionId);
      const { text, total } = (await ensureTranscript(stored, state)).read(cursor);
      return { ok: true, text, total, done: !state.running };
    },
    sessionFailure(sessionId) {
      if (deps.store.exists(sessionId) === false) {
        return 'Worker attempt interrupted: the worker session is missing from the session registry';
      }
      return live.get(sessionId)?.interruption;
    },
    onSessionFailure(listener) {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    async disposeSession(sessionId) {
      disposeLive(sessionId);
    },
  };

  return {
    implementsLauncher: () => launcher,
    setOrchestrationHostFactory(factory) {
      orchestrationHostFor = factory;
    },
    setWorkerHostFactory(factory) {
      workerHostFor = factory;
    },
    setCoordinatorLookup(lookup) {
      coordinatorOf = lookup;
    },
    start() {
      client.start();
    },
    async shutdown(timeoutMs) {
      for (const stored of deps.store.all()) {
        const state = live.get(stored.id);
        if (state) {
          state.activity += 1;
          state.roundEpoch += 1;
        }
        tellObservers((observer) => observer.activity?.(stored.id, 'abort'));
      }
      wakeRounds();
      deps.store.flush();
      await client.shutdown(timeoutMs);
      failDescribes(translate('agent.workerUnavailable'));
      for (const [sessionId, state] of live) {
        if (state.running) {
          interrupted(
            sessionId,
            state,
            'Worker attempt interrupted: the application shut down during the run'
          );
        }
        detach(sessionId, state);
      }
      deps.store.flush();
    },
    list(workspaceId) {
      const sessions = deps.store.list(workspaceId);
      // 列表马上返回缓存里的分支；分支在后台重读，变了再广播 sessions:changed
      rereadBranches(sessions.map((session) => session.cwd));
      return sessions.map(withBranch);
    },
    async create(input) {
      const workspace = deps.workspaces.get(input.workspaceId);
      if (!workspace) return fail(translate('common.workspaceNotFound'));
      let role: Role | undefined;
      try {
        role = await deps.roles.get(input.roleId);
      } catch (error) {
        return fail(errorMessage(error));
      }
      if (!role) return fail(translate('agent.roleNotFound', { id: input.roleId }));
      // 没选模型时用角色的模型与思考档位，角色也没配就由解析器取默认模型
      const requested = input.model ?? modelRefOf(role);
      const resolved = await deps.models.resolve(requested && bareRef(requested));
      if (!resolved.ok) return resolved;
      const model = sessionModelOf(resolved.ref, requested?.thinking, resolved.model.fastMode);
      const time = now();
      const stored: StoredSession = {
        id: newId(),
        workspaceId: workspace.id,
        roleId: role.id,
        title: role.name,
        cwd: workspace.repoPath,
        status: 'idle',
        createdAt: time,
        updatedAt: time,
        model,
        approvalMode: role.approvalMode,
        autoTitle: true,
      };
      deps.store.put(stored);
      deps.lastModels?.set(workspace.id, model);
      changed(workspace.id);
      return { ok: true, session: summaryOf(stored) };
    },
    remove,
    prompt,
    promptWhenIdle,
    steer,
    suggestReply,
    async retryCompaction(sessionId) {
      const stored = deps.store.get(sessionId);
      if (!stored) return fail(translate('common.sessionNotFound'));
      const state = liveOf(sessionId);
      if (isBusy(stored)) return fail(translate('agent.switchWhileRunning'));
      if (state.spawned && state.contextRuntime && !state.contextRuntime.recoveryRequired)
        return fail(translate('agent.noCompactionRecovery'));
      invalidateSuggestion(sessionId, state);
      const operation: PendingCompactionRecovery = {
        requestId: `compaction-recovery-${++recoverySeq}`,
        phase: 'loading',
        cancelled: false,
      };
      state.recovery = operation;
      state.running = true;
      state.interruption = undefined;
      state.lastError = undefined;
      setStatus(sessionId, 'running');
      // ACK acceptance now. Opening the original jsonl and checking its checkpoint happen asynchronously.
      void startRecovery(stored, state, operation);
      return { ok: true };
    },
    async abort(sessionId) {
      if (!deps.store.get(sessionId)) return fail(translate('common.sessionNotFound'));
      const state = liveOf(sessionId);
      invalidateSuggestion(sessionId, state);
      state.activity += 1;
      state.roundEpoch += 1;
      const recovery = state.recovery;
      if (recovery) {
        recovery.cancelled = true;
        if (recovery.phase === 'loading') {
          // No recovery command was sent. Invalidate pending reads before they can spawn, and discard
          // a spawn that won the final microtask race without killing the shared worker process.
          if (state.spawned)
            send({ type: 'dispose-session', identity: identityOf(sessionId, state) });
          detach(sessionId, state);
          setStatus(sessionId, 'idle');
        }
      }
      for (const [requestId, pending] of approvals) {
        if (pending.sessionId === sessionId) approvals.delete(requestId);
      }
      wakeRounds();
      tellObservers((observer) => observer.activity?.(sessionId, 'abort'));
      if (!state.spawned) return { ok: true };
      return send({ type: 'abort', identity: identityOf(sessionId, state) })
        ? { ok: true }
        : fail(translate('agent.workerUnavailable'));
    },
    async history(sessionId) {
      const stored = deps.store.get(sessionId);
      if (!stored) return fail(translate('common.sessionNotFound'));
      rereadBranches([stored.cwd]);
      try {
        const messages = await readHistory(sessionFilePath(deps.agentDir, sessionId), sessionId, {
          running: live.get(sessionId)?.running ?? false,
        });
        const state = live.get(sessionId);
        return {
          ok: true,
          messages,
          ...(state?.contextRuntime
            ? { contextRuntime: state.contextRuntime, contextRuntimeSeq: state.contextRuntimeSeq }
            : {}),
        };
      } catch (error) {
        return fail(translate('agent.historyFailed', { error: errorMessage(error) }));
      }
    },
    async respondApproval({ sessionId, requestId, decision }) {
      const pending = approvals.get(requestId);
      if (!pending || pending.sessionId !== sessionId)
        return fail(translate('agent.approvalNotFound'));
      approvals.delete(requestId);
      if (now() >= pending.expiresAt) return fail(translate('agent.approvalExpired'));
      const state = live.get(sessionId);
      if (!state?.spawned || state.generation !== pending.generation) {
        return fail(translate('agent.approvalStale'));
      }
      const identity = { sessionId, generation: pending.generation };
      return send({ type: 'respond-approval', identity, requestId, decision })
        ? { ok: true }
        : fail(translate('agent.workerUnavailable'));
    },
    setModel,
    modelOptions,
    setApprovalMode,
    refreshBranches() {
      if (deps.branches) rereadBranches(deps.branches.known());
    },
    get(sessionId) {
      const stored = deps.store.get(sessionId);
      return stored ? summaryOf(stored) : undefined;
    },
    observe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function defaultLog(level: LogLevel, message: string): void {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

/** 角色配的模型（含思考档位） */
function modelRefOf(role: Role): SessionModelRef | undefined {
  return role.model ? sessionModelOf(role.model, role.model.thinking) : undefined;
}

function qualifiedModelId({ providerId, modelId }: ModelRef): string {
  return `${providerId}/${modelId}`;
}

/** 交给解析器的引用：服务 id、模型 id 与 Fast 开关；思考档位由会话记录另外带 */
function bareRef({ providerId, modelId, fastMode }: ModelRef): ModelRef {
  return { providerId, modelId, ...(fastMode === true ? { fastMode: true } : {}) };
}

/**
 * 会话记录只存设置里的服务 id、模型 id、思考档位与 Fast（不带运行时 provider 键、key 等）。
 * Fast 只取解析器确认过协议后的值：切到不支持的模型时记录里自动清掉。
 */
function sessionModelOf(
  { providerId, modelId }: ModelRef,
  thinking?: ThinkingLevel,
  fastMode?: boolean
): SessionModelRef {
  return {
    providerId,
    modelId,
    ...(thinking ? { thinking } : {}),
    ...(fastMode === true ? { fastMode: true } : {}),
  };
}

function withThinking(spec: ResolvedModelSpec, thinking?: ThinkingLevel): ResolvedModelSpec {
  return thinking ? { ...spec, thinking } : spec;
}

function withReasoning(spec: ResolvedModelSpec, reasoning: boolean | undefined): ResolvedModelSpec {
  return reasoning === undefined ? spec : { ...spec, reasoning };
}

function queryOf(view: ModelProviderView, entry: ModelEntry): ModelQuery {
  return {
    api: view.api,
    modelId: entry.id,
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
  };
}

/** 缓存键：worker 只按协议、模型 id 与 reasoning 标记作答 */
function capabilityKey({ api, modelId, reasoning }: ModelQuery): string {
  return JSON.stringify([api, modelId, reasoning === true]);
}

function roleOptions(roles: readonly Role[]): AgentRoleOption[] {
  return roles.map(({ id, name, description }) =>
    description ? { id, name, description } : { id, name }
  );
}

/** 会话标题：第一行非空文本去掉 Markdown 标记，压成一行 */
export function titleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((candidate) => candidate.replace(/^[\s#>*\-+]+/, '').trim())
      .find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…` : flat;
}
