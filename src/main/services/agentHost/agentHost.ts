import { randomUUID } from 'node:crypto';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import type {
  ApprovalMode,
  FynvraSessionEvent,
  FynvraSessionEventBody,
  Role,
  ThinkingLevel,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
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
  ChatMessage,
  ModelOptions,
  ModelThinkingCapability,
  SessionEventEnvelope,
  SessionModelRef,
  SessionStatus,
  SessionSummary,
} from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { ModelEntry, ModelProviderView } from '@shared/types/llm';
import type { Workspace } from '@shared/types/workspace';
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
  prompt(sessionId: string, text: string): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  history(sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>>;
  respondApproval(input: RespondApprovalInput): Promise<IpcResult>;
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
}

/** Main 侧每个会话的运行态（不落盘） */
interface LiveSession {
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
  running: boolean;
  /** 还在途的 prompt（spawn / 发出之前）：这期间不能换模型，否则 spawn 用的还是旧模型 */
  prompting: number;
  transcript: Transcript | null;
  /** 进行中的 host 调用：`<generation>:<callId>` → 中止器 */
  calls: Map<string, AbortController>;
}

interface PendingApproval {
  sessionId: string;
  generation: number;
  expiresAt: number;
}

type Result<T extends object = object> = IpcResult<T>;

const WORKER_UNAVAILABLE = 'agent worker 未就绪（正在重启或已停止），请稍后重试';
const NO_ORCHESTRATION_HOST =
  'orchestration is not wired yet: this build has no OrchestrationHost for this session, so orchestration tools cannot run';
const NO_WORKER_HOST =
  'this session has no coordinator: it was not dispatched by an orchestrator, or the worker host is not wired yet';
const SWITCH_WHILE_RUNNING = '会话正在运行，等本轮结束再切换模型';
const TITLE_MAX_CHARS = 60;
const DESCRIBE_TIMEOUT_MS = 15_000;

/**
 * Main 侧的 agent 会话管理（EnsoCode agentHost 的精简版）：
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
  const describeTimeoutMs = deps.describeTimeoutMs ?? DESCRIBE_TIMEOUT_MS;
  const live = new Map<string, LiveSession>();
  const approvals = new Map<string, PendingApproval>();
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
        running: false,
        prompting: 0,
        transcript: null,
        calls: new Map(),
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
    return withBranch(toSummary(stored));
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

  function setStatus(sessionId: string, status: SessionStatus): void {
    const stored = deps.store.get(sessionId);
    if (!stored || stored.status === status) return;
    deps.store.update(sessionId, { status, updatedAt: now() });
    changed(stored.workspaceId);
  }

  /** 推一条事件给 Renderer（同时进 transcript），seq 改写为会话级 */
  function deliver(sessionId: string, state: LiveSession, event: FynvraSessionEventBody): void {
    state.transcript?.append(event);
    state.sessionSeq += 1;
    const envelope: SessionEventEnvelope = {
      sessionId,
      event: { ...event, seq: state.sessionSeq } as FynvraSessionEvent,
    };
    deps.broadcast(IPC_CHANNELS.SESSIONS_EVENT, envelope);
  }

  /** 会话不再在 worker 里：中止它进行中的 host 调用，作废待审批请求 */
  function detach(sessionId: string, state: LiveSession): void {
    state.spawned = false;
    state.running = false;
    for (const controller of state.calls.values()) controller.abort();
    state.calls.clear();
    for (const [requestId, pending] of approvals) {
      if (pending.sessionId === sessionId) approvals.delete(requestId);
    }
  }

  function send(command: AgentCommand): boolean {
    return client.send(command);
  }

  function spawnWith(sessionId: string, state: LiveSession, spec: SpawnSessionSpec): boolean {
    state.generation += 1;
    state.workerSeq = 0;
    state.spec = spec;
    state.spawned = send({ type: 'spawn-session', identity: identityOf(sessionId, state), spec });
    return state.spawned;
  }

  async function buildSpec(stored: StoredSession): Promise<Result<{ spec: SpawnSessionSpec }>> {
    try {
      const role = await deps.roles.get(stored.roleId);
      if (!role) return fail(`角色不存在：${stored.roleId}`);
      const resolved = await deps.models.resolve(stored.model ?? modelRefOf(role));
      if (!resolved.ok) return resolved;
      const model = withReasoning(resolved.model, await reasoningOf(resolved.ref));
      const resources = await resolveResources(role);
      for (const warning of resources.warnings) log('warn', `session ${stored.id}: ${warning}`);
      const roles = role.tools === 'orchestrator' ? roleOptions(await deps.roles.list()) : [];
      const shellPath = await resolveShellPath();
      return {
        ok: true,
        spec: {
          // 审批门按会话自己的档位建（创建时取自角色，之后可能被用户切过）
          role: { ...role, approvalMode: stored.approvalMode },
          cwd: stored.cwd,
          sessionFile: sessionFilePath(deps.agentDir, stored.id),
          model,
          skills: resources.skills,
          mcpServers: resources.mcpServers,
          worker: stored.dispatchId !== undefined,
          roles,
          ...(shellPath ? { shellPath } : {}),
        },
      };
    } catch (error) {
      return fail(`无法启动会话：${errorMessage(error)}`);
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
        return fail('agent worker 回答的模型数与查询不一致');
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
        () => settle(fail('读取模型的思考档位超时：agent worker 没有回答，请稍后重试')),
        describeTimeoutMs
      );
      const settle = (result: ModelsDescribedResult) => {
        clearTimeout(timer);
        describing.delete(requestId);
        resolve(result);
      };
      describing.set(requestId, settle);
      if (!send({ type: 'describe-models', requestId, models })) settle(fail(WORKER_UNAVAILABLE));
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
  async function ensureSpawned(stored: StoredSession): Promise<Result> {
    const state = liveOf(stored.id);
    if (state.spawned) return { ok: true };
    if (client.state === 'stopped') client.start();
    if (client.state !== 'starting' && client.state !== 'ready') return fail(WORKER_UNAVAILABLE);
    const built = await buildSpec(stored);
    if (!built.ok) return built;
    await ensureTranscript(stored, state);
    if (!deps.store.get(stored.id)) return fail('会话不存在');
    if (state.spawned) return { ok: true };
    return spawnWith(stored.id, state, built.spec) ? { ok: true } : fail(WORKER_UNAVAILABLE);
  }

  function handleEvent(event: Exclude<AgentWorkerEvent, { type: 'ready' }>): void {
    switch (event.type) {
      case 'session-event': {
        const state = currentOf(event.identity);
        // 过期 generation、重复或乱序的 seq 一律丢弃
        if (!state || event.seq <= state.workerSeq) return;
        state.workerSeq = event.seq;
        const { sessionId } = event.identity;
        deliver(sessionId, state, event.event);
        if (event.event.type === 'agent_settled') {
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
        if (event.fatal) detach(sessionId, state);
        deliver(sessionId, state, { type: 'error', source: 'host', message: event.error });
        setStatus(sessionId, 'error');
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
        const host = stored.dispatchId !== undefined ? workerHostFor(stored.id) : null;
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
      title: protectedAction ? `${title}（保护底线：${protectedAction}）` : title,
      detail,
      expiresAt,
    };
    deps.broadcast(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST, pushed);
  }

  function handleCrash(code: number, willRestart: boolean): void {
    failDescribes(`agent worker 进程意外退出（code ${code}），没能读到模型的思考档位，请重试`);
    for (const [sessionId, state] of live) {
      if (!state.spawned) continue;
      const wasRunning = state.running;
      detach(sessionId, state);
      state.respawn = willRestart;
      if (!wasRunning) continue;
      deliver(sessionId, state, {
        type: 'error',
        source: 'host',
        message: willRestart
          ? `agent worker 进程意外退出（code ${code}），正在重启；这一轮已中断，可以重新发送`
          : `agent worker 进程意外退出（code ${code}），短时间内崩溃过多，已停止自动重启；再次发送消息会重新启动它`,
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
      if (state.spec && deps.store.get(sessionId)) spawnWith(sessionId, state, state.spec);
    }
  }

  async function prompt(sessionId: string, text: string): Promise<Result> {
    const stored = deps.store.get(sessionId);
    if (!stored) return fail('会话不存在');
    const pending = liveOf(sessionId);
    pending.prompting += 1;
    try {
      const spawned = await ensureSpawned(stored);
      if (!spawned.ok) return spawned;
      const state = liveOf(sessionId);
      if (!send({ type: 'prompt', identity: identityOf(sessionId, state), text })) {
        return fail(WORKER_UNAVAILABLE);
      }
      state.running = true;
      const current = deps.store.get(sessionId) ?? stored;
      deps.store.update(sessionId, {
        status: 'running',
        updatedAt: now(),
        ...(current.autoTitle ? { title: titleFrom(text) || current.title, autoTitle: false } : {}),
      });
      changed(stored.workspaceId);
      return { ok: true };
    } finally {
      pending.prompting -= 1;
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
    if (!stored) return fail('会话不存在');
    if (isBusy(stored)) return fail(SWITCH_WHILE_RUNNING);
    const resolved = await deps.models.resolve(bareRef(model));
    if (!resolved.ok) return resolved;
    const reasoning = await reasoningOf(resolved.ref);
    const current = deps.store.get(sessionId);
    if (!current) return fail('会话不存在');
    if (isBusy(current)) return fail(SWITCH_WHILE_RUNNING);

    const next = sessionModelOf(resolved.ref, model.thinking);
    const updated =
      deps.store.update(sessionId, {
        model: next,
        updatedAt: now(),
        // 换模型常是为了绕开上一轮的错误（如 key 失效）：回到空闲
        ...(current.status === 'error' ? { status: 'idle' as const } : {}),
      }) ?? current;
    const state = live.get(sessionId);
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
    if (!stored) return fail('会话不存在');
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
      return fail(`读取模型服务失败：${errorMessage(error)}`);
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
    if (!stored) return fail('会话不存在');
    disposeLive(sessionId);
    live.delete(sessionId);
    // 只删注册表记录；pi jsonl 保留（会话正文的权威源，误删可从文件恢复）
    deps.store.remove(sessionId);
    changed(stored.workspaceId);
    return { ok: true };
  }

  const launcher: WorkerSessionLauncher = {
    async createWorkerSession(input) {
      if (!deps.workspaces.get(input.workspaceId)) return fail('工作区不存在');
      let role: Role | undefined;
      try {
        role = await deps.roles.get(input.roleId);
      } catch (error) {
        return fail(errorMessage(error));
      }
      if (!role) return fail(`角色不存在：${input.roleId}`);
      const parentSessionId = coordinatorOf(input.workspaceId, input.runId);
      // 角色配了模型用角色的；没配就跟主 agent 当前的模型与思考档位
      const requested =
        modelRefOf(role) ?? (parentSessionId ? deps.store.get(parentSessionId)?.model : undefined);
      const resolved = await deps.models.resolve(requested && bareRef(requested));
      if (!resolved.ok) return resolved;
      const time = now();
      const stored: StoredSession = {
        id: newId(),
        workspaceId: input.workspaceId,
        roleId: role.id,
        title: titleFrom(input.brief) || role.name,
        cwd: input.cwd,
        worktreeId: input.worktreeId,
        ...(parentSessionId ? { parentSessionId } : {}),
        dispatchId: input.dispatchId,
        status: 'idle',
        createdAt: time,
        updatedAt: time,
        model: sessionModelOf(resolved.ref, requested?.thinking),
        // 按派出的角色自己的档位，不继承主 agent 会话的
        approvalMode: role.approvalMode,
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
    async promptSession(sessionId, text) {
      const result = await prompt(sessionId, text);
      return result.ok ? { ok: true } : result;
    },
    async readTranscript(sessionId, cursor) {
      const stored = deps.store.get(sessionId);
      if (!stored) return fail('会话不存在');
      const state = liveOf(sessionId);
      const { text, total } = (await ensureTranscript(stored, state)).read(cursor);
      return { ok: true, text, total, done: !state.running };
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
      deps.store.flush();
      await client.shutdown(timeoutMs);
      failDescribes(WORKER_UNAVAILABLE);
      for (const [sessionId, state] of live) detach(sessionId, state);
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
      if (!workspace) return fail('工作区不存在');
      let role: Role | undefined;
      try {
        role = await deps.roles.get(input.roleId);
      } catch (error) {
        return fail(errorMessage(error));
      }
      if (!role) return fail(`角色不存在：${input.roleId}`);
      // 没选模型时用角色的模型与思考档位，角色也没配就由解析器取默认模型
      const requested = input.model ?? modelRefOf(role);
      const resolved = await deps.models.resolve(requested && bareRef(requested));
      if (!resolved.ok) return resolved;
      const model = sessionModelOf(resolved.ref, requested?.thinking);
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
    async abort(sessionId) {
      if (!deps.store.get(sessionId)) return fail('会话不存在');
      const state = live.get(sessionId);
      if (!state?.spawned) return { ok: true };
      return send({ type: 'abort', identity: identityOf(sessionId, state) })
        ? { ok: true }
        : fail(WORKER_UNAVAILABLE);
    },
    async history(sessionId) {
      const stored = deps.store.get(sessionId);
      if (!stored) return fail('会话不存在');
      rereadBranches([stored.cwd]);
      try {
        const messages = await readHistory(sessionFilePath(deps.agentDir, sessionId), sessionId, {
          running: live.get(sessionId)?.running ?? false,
        });
        return { ok: true, messages };
      } catch (error) {
        return fail(`读取会话记录失败：${errorMessage(error)}`);
      }
    },
    async respondApproval({ sessionId, requestId, decision }) {
      const pending = approvals.get(requestId);
      if (!pending || pending.sessionId !== sessionId) return fail('审批请求不存在或已处理');
      approvals.delete(requestId);
      if (now() > pending.expiresAt) return fail('审批请求已过期');
      const state = live.get(sessionId);
      if (!state?.spawned || state.generation !== pending.generation) {
        return fail('会话已重启，审批请求已失效');
      }
      const identity = { sessionId, generation: pending.generation };
      return send({ type: 'respond-approval', identity, requestId, decision })
        ? { ok: true }
        : fail(WORKER_UNAVAILABLE);
    },
    setModel,
    modelOptions,
    setApprovalMode,
    refreshBranches() {
      if (deps.branches) rereadBranches(deps.branches.known());
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

/** 交给解析器的引用：只有服务 id 与模型 id，思考档位由会话记录另外带 */
function bareRef({ providerId, modelId }: ModelRef): ModelRef {
  return { providerId, modelId };
}

/** 会话记录只存设置里的服务 id、模型 id 与思考档位（不带运行时 provider 键、key 等） */
function sessionModelOf(
  { providerId, modelId }: ModelRef,
  thinking?: ThinkingLevel
): SessionModelRef {
  return { providerId, modelId, ...(thinking ? { thinking } : {}) };
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
