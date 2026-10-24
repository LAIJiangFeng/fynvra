import { randomUUID } from 'node:crypto';
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import type { FynvraSessionEvent, FynvraSessionEventBody, Role } from '@fynvra/core';
import { asRecord, errorMessage } from '@shared/guards';
import {
  type AgentCommand,
  type AgentMcpServer,
  type AgentRoleOption,
  type AgentWorkerEvent,
  APPROVAL_TIMEOUT_MS,
  type HostCallResult,
  type LogLevel,
  type SessionIdentity,
  type SpawnSessionSpec,
} from '@shared/types/agent';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ChatMessage,
  SessionEventEnvelope,
  SessionStatus,
  SessionSummary,
} from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { Workspace } from '@shared/types/workspace';
import { readHistory, sessionFilePath } from '../sessions/history';
import { type SessionStore, type StoredSession, toSummary } from '../sessions/sessionStore';
import { invokeOrchestrationHost, invokeWorkerHost } from './hostDispatch';
import { Transcript } from './transcript';
import type { AgentHost, ModelResolver, WorkerSessionLauncher } from './types';
import { createWorkerClient, type WorkerClientOptions, type WorkerProcess } from './workerClient';

export interface RoleSource {
  get(id: string): Promise<Role | undefined>;
  list(): Promise<Role[]>;
}

export interface RoleResources {
  skills: string[];
  mcpServers: AgentMcpServer[];
}

export interface AgentHostDeps {
  fork(): WorkerProcess;
  /** userData/agent：pi 的 agentDir，会话 jsonl 在它的 sessions/ 下 */
  agentDir: string;
  store: SessionStore;
  workspaces: { get(id: string): Workspace | undefined };
  roles: RoleSource;
  models: ModelResolver;
  /** Main → Renderer 推送（生产为 sendToAllWindows） */
  broadcast(channel: string, ...args: unknown[]): void;
  /** role.skillIds / mcpServerIds → 路径与服务器配置；settings-ui 的注册表接入前默认都为空 */
  resolveResources?(role: Role): Promise<RoleResources>;
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
  model?: { providerId: string; modelId: string };
}

export interface RespondApprovalInput {
  sessionId: string;
  requestId: string;
  decision: ApprovalDecision;
}

/** AgentHost（§9.5）加上 sessions IPC 用到的会话操作 */
export interface AgentHostService extends AgentHost {
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
const TITLE_MAX_CHARS = 60;
const APPROVAL_DETAIL_MAX_CHARS = 500;

/**
 * Main 侧的 agent 会话管理（EnsoCode agentHost 的精简版）：
 * - 托管一个 agent worker 进程（workerClient：fork、ready 握手、崩溃重启）；
 * - 会话注册表在 sessions.json，正文在 pi jsonl；会话首次使用时才在 worker 里 spawn（新 generation）；
 * - worker 事件已由 workerClient 收窄，这里再丢弃过期 generation / 重复 seq，改写为会话级 seq 后推给 Renderer；
 * - 编排 / worker 工具的 host-invoke 交给注入的 OrchestrationHost / WorkerHost 工厂执行；
 * - worker 崩溃后 generation+1 重新 spawn 崩溃前的会话，进行中的回合按中止处理。
 */
export function createAgentHost(deps: AgentHostDeps): AgentHostService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? defaultLog;
  const resolveResources =
    deps.resolveResources ?? (async (): Promise<RoleResources> => ({ skills: [], mcpServers: [] }));
  const live = new Map<string, LiveSession>();
  const approvals = new Map<string, PendingApproval>();
  let orchestrationHostFor: (
    coordinatorSessionId: string,
    workspaceId: string
  ) => OrchestrationHost | null = () => null;
  let workerHostFor: (sessionId: string) => WorkerHost | null = () => null;

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
      const resources = await resolveResources(role);
      const roles = role.tools === 'orchestrator' ? roleOptions(await deps.roles.list()) : [];
      return {
        ok: true,
        spec: {
          role,
          cwd: stored.cwd,
          sessionFile: sessionFilePath(deps.agentDir, stored.id),
          model: resolved.model,
          skills: resources.skills,
          mcpServers: resources.mcpServers,
          worker: stored.dispatchId !== undefined,
          roles,
        },
      };
    } catch (error) {
      return fail(`无法启动会话：${errorMessage(error)}`);
    }
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
        if (event.event.type === 'approval_request') {
          announceApproval(sessionId, event.identity.generation, event.event);
        }
        if (event.event.type === 'agent_settled') {
          for (const [requestId, pending] of approvals) {
            if (pending.sessionId === sessionId) approvals.delete(requestId);
          }
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
      case 'session-error': {
        const state = currentOf(event.identity);
        if (!state) return;
        const { sessionId } = event.identity;
        if (event.fatal) detach(sessionId, state);
        deliver(sessionId, state, { type: 'error', source: 'host', message: event.error });
        setStatus(sessionId, 'error');
        return;
      }
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

  function announceApproval(
    sessionId: string,
    generation: number,
    event: Extract<FynvraSessionEventBody, { type: 'approval_request' }>
  ): void {
    const expiresAt = now() + APPROVAL_TIMEOUT_MS;
    approvals.set(event.requestId, { sessionId, generation, expiresAt });
    const request: ApprovalRequest = {
      id: event.requestId,
      sessionId,
      kind: approvalKindOf(event.toolName),
      title: event.toolName,
      detail: describeArgs(event.args),
      expiresAt,
    };
    deps.broadcast(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST, request);
  }

  function handleCrash(code: number, willRestart: boolean): void {
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
  }

  function disposeLive(sessionId: string): void {
    const state = live.get(sessionId);
    if (!state?.spawned) return;
    send({ type: 'dispose-session', identity: identityOf(sessionId, state) });
    detach(sessionId, state);
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
      const resolved = await deps.models.resolve(modelRefOf(role));
      if (!resolved.ok) return resolved;
      const time = now();
      const stored: StoredSession = {
        id: newId(),
        workspaceId: input.workspaceId,
        roleId: role.id,
        title: titleFrom(input.brief) || role.name,
        cwd: input.cwd,
        worktreeId: input.worktreeId,
        dispatchId: input.dispatchId,
        status: 'idle',
        createdAt: time,
        updatedAt: time,
        model: { providerId: resolved.model.providerId, modelId: resolved.model.modelId },
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
    start() {
      client.start();
    },
    async shutdown(timeoutMs) {
      deps.store.flush();
      await client.shutdown(timeoutMs);
      for (const [sessionId, state] of live) detach(sessionId, state);
      deps.store.flush();
    },
    list: (workspaceId) => deps.store.list(workspaceId),
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
      const resolved = await deps.models.resolve(input.model ?? modelRefOf(role));
      if (!resolved.ok) return resolved;
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
        model: { providerId: resolved.model.providerId, modelId: resolved.model.modelId },
        autoTitle: true,
      };
      deps.store.put(stored);
      changed(workspace.id);
      return { ok: true, session: toSummary(stored) };
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
      if (!deps.store.get(sessionId)) return fail('会话不存在');
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

function modelRefOf(role: Role): { providerId: string; modelId: string } | undefined {
  return role.model
    ? { providerId: role.model.providerId, modelId: role.model.modelId }
    : undefined;
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

function approvalKindOf(toolName: string): ApprovalKind {
  if (toolName === 'edit') return 'file-edit';
  if (toolName === 'write') return 'file-write';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'command';
}

function describeArgs(args: unknown): string {
  const record = asRecord(args);
  if (typeof record?.command === 'string') return record.command;
  if (typeof record?.path === 'string') return record.path;
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    text = '';
  }
  return text.length > APPROVAL_DETAIL_MAX_CHARS
    ? `${text.slice(0, APPROVAL_DETAIL_MAX_CHARS - 1)}…`
    : text;
}
