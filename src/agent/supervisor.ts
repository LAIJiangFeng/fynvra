import { randomUUID } from 'node:crypto';
import type {
  ApprovalGateRequest,
  ApprovalPolicyHooks,
  OrchestrationHost,
  WorkerHost,
} from '@fynvra/agent-runtime';
import type { ApprovalMode, FynvraSessionEvent, FynvraSessionEventBody } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import {
  type AgentCommand,
  type AgentWorkerEvent,
  APPROVAL_TIMEOUT_MS,
  type HostKind,
  type LogLevel,
  type ModelQuery,
  type ModelsDescribedResult,
  type ResolvedModelSpec,
  type SessionIdentity,
  type SpawnSessionSpec,
} from '@shared/types/agent';
import type {
  ApprovalDecision,
  ChatImage,
  ModelThinkingCapability,
  SessionStatus,
} from '@shared/types/chat';
import { ApprovalBroker } from './approvals';
import {
  createHostInvoker,
  type HostCall,
  type HostInvoker,
  type HostInvokerOptions,
  orchestrationHostProxy,
  workerHostProxy,
} from './hostProxy';

/** supervisor 托管的会话：pi AgentSession 经 createRoleSession / subscribeNormalized 包装后的最小面 */
export interface SupervisedSession {
  /** skill / MCP 等配置问题，转成 log 交给 Main */
  readonly warnings: readonly string[];
  /** 订阅归一化事件（seq 从 1 递增）；emit 把宿主事件注入同一条 seq 序列 */
  subscribe(listener: (event: FynvraSessionEvent) => void): SessionEvents;
  /** 空闲时开始新一轮；运行中排到当前回合之后。images 是用户粘贴的图片，交给 pi 规整后随消息发出 */
  prompt(text: string, images?: ChatImage[]): Promise<void>;
  steer(text: string): Promise<void>;
  /** 换模型 / 思考档位：下一次请求起生效，会话历史保留；失败抛错 */
  setModel(spec: ResolvedModelSpec): Promise<void>;
  /** 换审批档位：从下一次需要审批的工具调用起生效，回合进行中也可以；失败抛错 */
  setApprovalMode(mode: ApprovalMode): void;
  abort(): Promise<void>;
  /** 没有进行中的回合、重试或排队消息 */
  isIdle(): boolean;
  dispose(): Promise<void>;
}

export interface SessionEvents {
  unsubscribe(): void;
  emit(event: FynvraSessionEventBody): void;
}

export interface OpenSessionInput {
  identity: SessionIdentity;
  spec: SpawnSessionSpec;
  /** 仅 `tools: 'orchestrator'` 的角色有：编排工具的调用经 host-invoke 转给 Main */
  host: OrchestrationHost | null;
  /** 仅 `spec.worker` 的会话有：ask_coordinator / report_done 经 host-invoke 转给 Main */
  workerHost: WorkerHost | null;
  /**
   * 审批门的通道（createRoleSession 的 `approval`）：请求经 Main 交给 Renderer 的审批条。
   * supervisor 总会提供；缺省时需要审批的调用一律拒绝（fail-closed）。
   */
  approval?: ApprovalPolicyHooks;
}

export type OpenSession = (input: OpenSessionInput) => Promise<SupervisedSession>;

export interface SupervisorOptions {
  post(event: AgentWorkerEvent): void;
  openSession: OpenSession;
  /** describe-models：按 pi 内置目录算模型的思考档位，结果与 queries 一一对应 */
  describeModels?: (queries: ModelQuery[]) => Promise<ModelThinkingCapability[]>;
  hostCalls?: HostInvokerOptions;
  approvalTimeoutMs?: number;
}

interface ManagedSession {
  identity: SessionIdentity;
  /** 创建完成（失败为 null）；同一会话的命令都排在它之后，换模型也接在它上面 */
  opening: Promise<SupervisedSession | null>;
  events: SessionEvents | null;
  status: SessionStatus;
  /** 本轮出过错：settle 后报 error 而不是 idle */
  failed: boolean;
  closed: boolean;
}

/**
 * Agent worker 进程里的多会话托管。
 * 命令先由入口经 parseAgentCommand 收窄；identity 的 generation 必须与当前会话一致，过期的命令丢弃。
 */
export class SessionSupervisor {
  readonly #post: (event: AgentWorkerEvent) => void;
  readonly #open: OpenSession;
  readonly #describeModels: SupervisorOptions['describeModels'];
  readonly #invoker: HostInvoker;
  readonly #approvals = new ApprovalBroker();
  readonly #approvalTimeoutMs: number;
  readonly #sessions = new Map<string, ManagedSession>();
  #shutdown: Promise<void> | null = null;

  constructor(options: SupervisorOptions) {
    this.#post = options.post;
    this.#open = options.openSession;
    this.#describeModels = options.describeModels;
    this.#invoker = createHostInvoker(options.post, options.hostCalls);
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  /** 处理一条已收窄的命令。永不抛异常，异步失败转成 session-error / log。 */
  handle(command: AgentCommand): void {
    if (this.#shutdown && command.type !== 'shutdown') {
      this.#log('warn', `ignored ${command.type}: the agent worker is shutting down`);
      return;
    }
    switch (command.type) {
      case 'spawn-session':
        this.#spawn(command.identity, command.spec);
        return;
      case 'prompt':
        void this.#run(command.identity, command.text, 'prompt', command.images);
        return;
      case 'steer':
        void this.#run(command.identity, command.text, 'steer');
        return;
      case 'abort':
        void this.#abort(command.identity);
        return;
      case 'dispose-session':
        void this.#dispose(command.identity);
        return;
      case 'respond-approval': {
        const { identity, requestId, decision } = command;
        const answered =
          this.#current(identity) !== undefined &&
          this.#approvals.respond(identity.sessionId, requestId, decision);
        if (!answered)
          this.#log('warn', `no pending approval ${requestId} for ${identity.sessionId}`);
        return;
      }
      case 'host-result':
        if (!this.#invoker.settle(command.identity, command.callId, command.result)) {
          this.#log('info', `dropped host-result ${command.callId}: the call is no longer pending`);
        }
        return;
      case 'set-model':
        this.#setModel(command.identity, command.model);
        return;
      case 'set-approval-mode':
        this.#setApprovalMode(command.identity, command.mode);
        return;
      case 'describe-models':
        void this.#describe(command.requestId, command.models);
        return;
      case 'shutdown':
        void this.shutdown();
        return;
    }
  }

  /** 关闭全部会话（可重复调用）；之后的命令一律忽略 */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      this.#invoker.cancelAll('the agent worker is shutting down');
      await Promise.allSettled(sessions.map((managed) => this.#close(managed)));
    })();
    return this.#shutdown;
  }

  /**
   * 审批门（agent-runtime 按 role.approvalMode 拦截的工具调用）的人工审批：
   * 先发 approval-request 让 Main 记下并推审批条，再发 approval_request 会话事件进时间线，然后挂起，
   * 直到 Main 回 respond-approval。审批门撤回（超时、回合中止）、会话中止 / 关闭 / settle 都按 deny 结束。
   */
  async requestApproval(
    identity: SessionIdentity,
    request: ApprovalGateRequest,
    signal?: AbortSignal
  ): Promise<ApprovalDecision> {
    const managed = this.#current(identity);
    if (!managed?.events || managed.closed || signal?.aborted) return 'deny';
    const requestId = randomUUID();
    const decision = this.#approvals.request(
      identity.sessionId,
      requestId,
      this.#approvalTimeoutMs
    );
    const withdraw = () => this.#approvals.cancel(requestId);
    signal?.addEventListener('abort', withdraw, { once: true });
    const { toolCallId, toolName, kind, title, detail, protectedAction, expiresAt } = request;
    this.#post({
      type: 'approval-request',
      identity,
      request: {
        requestId,
        toolCallId,
        toolName,
        kind,
        title,
        detail,
        ...(protectedAction ? { protectedAction } : {}),
        expiresAt,
      },
    });
    managed.events.emit({
      type: 'approval_request',
      requestId,
      toolCallId,
      toolName,
      args: request.args,
      ...(protectedAction ? { reason: `protected action: ${protectedAction}` } : {}),
    });
    this.#setStatus(managed, 'waiting-approval');
    const result = await decision;
    signal?.removeEventListener('abort', withdraw);
    if (managed.status === 'waiting-approval' && !this.#approvals.hasPending(identity.sessionId)) {
      this.#setStatus(managed, 'running');
    }
    return result;
  }

  #spawn(identity: SessionIdentity, spec: SpawnSessionSpec): void {
    const existing = this.#sessions.get(identity.sessionId);
    if (existing && existing.identity.generation >= identity.generation) {
      this.#log(
        'warn',
        `ignored spawn-session for ${identity.sessionId}: generation ${identity.generation} is not newer than ${existing.identity.generation}`
      );
      return;
    }
    if (existing) void this.#close(existing);
    const managed: ManagedSession = {
      identity,
      opening: Promise.resolve(null),
      events: null,
      status: 'idle',
      failed: false,
      closed: false,
    };
    managed.opening = this.#openManaged(managed, spec);
    this.#sessions.set(identity.sessionId, managed);
  }

  async #openManaged(
    managed: ManagedSession,
    spec: SpawnSessionSpec
  ): Promise<SupervisedSession | null> {
    const { identity } = managed;
    const call =
      (kind: HostKind): HostCall =>
      (method, input, signal) =>
        this.#invoker.invoke(identity, kind, method, input, signal);
    let session: SupervisedSession;
    try {
      session = await this.#open({
        identity,
        spec,
        host:
          spec.role.tools === 'orchestrator' ? orchestrationHostProxy(call('orchestration')) : null,
        workerHost: spec.worker ? workerHostProxy(call('worker')) : null,
        approval: {
          request: (request, signal) => this.requestApproval(identity, request, signal),
          timeoutMs: this.#approvalTimeoutMs,
        },
      });
    } catch (error) {
      managed.closed = true;
      if (this.#sessions.get(identity.sessionId) === managed) {
        this.#sessions.delete(identity.sessionId);
      }
      this.#post({
        type: 'session-error',
        identity,
        error: `failed to start the session: ${errorMessage(error)}`,
        fatal: true,
      });
      return null;
    }
    if (managed.closed) {
      // 创建期间已被关闭（dispose / 新 generation / shutdown）
      await session.dispose().catch((error) => this.#log('warn', errorMessage(error)));
      return null;
    }
    managed.events = session.subscribe((event) => this.#onEvent(managed, event));
    for (const warning of session.warnings) {
      this.#log('warn', `session ${identity.sessionId}: ${warning}`);
    }
    return session;
  }

  #onEvent(managed: ManagedSession, event: FynvraSessionEvent): void {
    if (managed.closed) return;
    if (event.type === 'error') managed.failed = true;
    this.#post({ type: 'session-event', identity: managed.identity, seq: event.seq, event });
    if (event.type === 'agent_settled') {
      this.#approvals.cancelSession(managed.identity.sessionId);
      this.#setStatus(managed, managed.failed ? 'error' : 'idle');
    }
  }

  async #run(
    identity: SessionIdentity,
    text: string,
    mode: 'prompt' | 'steer',
    images?: ChatImage[]
  ): Promise<void> {
    const managed = this.#current(identity);
    if (!managed) {
      this.#reportMissing(identity, mode);
      return;
    }
    const session = await managed.opening;
    if (!session || managed.closed) return;
    const busy = managed.status === 'running' || managed.status === 'waiting-approval';
    const steering = mode === 'steer' && busy;
    if (!busy) {
      managed.failed = false;
      this.#setStatus(managed, 'running');
    }
    try {
      await (steering ? session.steer(text) : session.prompt(text, images));
    } catch (error) {
      if (managed.closed) return;
      managed.failed = true;
      managed.events?.emit({ type: 'error', source: 'host', message: errorMessage(error) });
    }
    // prompt 在回合开始前失败（如缺 API key）时不会有 agent_settled：会话已空闲就在这里收尾
    this.#settleIfIdle(managed, session);
  }

  /**
   * 换模型接在 opening 上：排在这个会话已到达的命令之后，之后到达的 prompt 一定用新模型。
   * 换不成功时 worker 里的会话与 Main 的记录（已是新模型）对不上：关掉它并报 fatal，
   * Main 下次使用前按记录重新 spawn。Main 只在空闲时发 set-model；与回合撞上时照样换，记一条日志。
   */
  #setModel(identity: SessionIdentity, spec: ResolvedModelSpec): void {
    const managed = this.#current(identity);
    if (!managed) {
      this.#reportMissing(identity, 'set-model');
      return;
    }
    managed.opening = managed.opening.then(async (session) => {
      if (!session || managed.closed) return session;
      if (managed.status === 'running' || managed.status === 'waiting-approval') {
        this.#log(
          'warn',
          `session ${identity.sessionId}: the model was switched during a turn; the rest of the turn uses the new model`
        );
      }
      try {
        await session.setModel(spec);
      } catch (error) {
        // 正在关闭：交给 #close 释放
        if (managed.closed) return session;
        await this.#abandon(managed, session, `failed to switch the model: ${errorMessage(error)}`);
        return null;
      }
      if (managed.status === 'error') this.#setStatus(managed, 'idle');
      return session;
    });
  }

  /**
   * 换审批档位同样接在 opening 上（排在已到达的命令之后），但不看回合：运行中也立即生效。
   * 换不成功时审批门可能还停在比记录宽松的旧档位：关掉会话并报 fatal，Main 下次使用前按记录重新 spawn。
   */
  #setApprovalMode(identity: SessionIdentity, mode: ApprovalMode): void {
    const managed = this.#current(identity);
    if (!managed) {
      this.#reportMissing(identity, 'set-approval-mode');
      return;
    }
    managed.opening = managed.opening.then(async (session) => {
      if (!session || managed.closed) return session;
      try {
        session.setApprovalMode(mode);
      } catch (error) {
        await this.#abandon(
          managed,
          session,
          `failed to switch the approval mode: ${errorMessage(error)}`
        );
        return null;
      }
      this.#log('info', `session ${identity.sessionId}: approval mode ${mode}`);
      return session;
    });
  }

  /** worker 里的会话已与 Main 的记录对不上：报 fatal、不再托管并释放它 */
  async #abandon(
    managed: ManagedSession,
    session: SupervisedSession,
    error: string
  ): Promise<void> {
    this.#post({ type: 'session-error', identity: managed.identity, error, fatal: true });
    this.#detach(managed);
    await session.dispose().catch((reason) => this.#log('warn', errorMessage(reason)));
  }

  /** 进程级查询：总是回一条 models-described，失败也回，Main 不必等到超时 */
  async #describe(requestId: string, models: ModelQuery[]): Promise<void> {
    let result: ModelsDescribedResult;
    try {
      if (!this.#describeModels) throw new Error('this agent worker cannot describe models');
      result = { ok: true, models: await this.#describeModels(models) };
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    this.#post({ type: 'models-described', requestId, result });
  }

  async #abort(identity: SessionIdentity): Promise<void> {
    const managed = this.#current(identity);
    if (!managed) return;
    const session = await managed.opening;
    if (!session || managed.closed) return;
    this.#approvals.cancelSession(identity.sessionId);
    try {
      await session.abort();
    } catch (error) {
      this.#log('warn', `abort ${identity.sessionId}: ${errorMessage(error)}`);
    }
    this.#settleIfIdle(managed, session);
  }

  async #dispose(identity: SessionIdentity): Promise<void> {
    const managed = this.#current(identity);
    if (!managed) return;
    this.#sessions.delete(identity.sessionId);
    await this.#close(managed);
  }

  async #close(managed: ManagedSession): Promise<void> {
    if (managed.closed) return;
    this.#detach(managed);
    const session = await managed.opening;
    if (!session) return;
    try {
      await session.dispose();
    } catch (error) {
      this.#log('warn', `dispose ${managed.identity.sessionId}: ${errorMessage(error)}`);
    }
  }

  /** 不再托管这个会话：结束它的 host 调用与待审批，停止转发事件；还是当前会话就从表里移除 */
  #detach(managed: ManagedSession): void {
    managed.closed = true;
    this.#invoker.cancelSession(managed.identity, 'the session was closed');
    this.#approvals.cancelSession(managed.identity.sessionId);
    managed.events?.unsubscribe();
    if (this.#sessions.get(managed.identity.sessionId) === managed) {
      this.#sessions.delete(managed.identity.sessionId);
    }
  }

  #settleIfIdle(managed: ManagedSession, session: SupervisedSession): void {
    if (managed.closed || !session.isIdle()) return;
    if (managed.status === 'running' || managed.status === 'waiting-approval') {
      this.#setStatus(managed, managed.failed ? 'error' : 'idle');
    }
  }

  #setStatus(managed: ManagedSession, status: SessionStatus): void {
    if (managed.closed || managed.status === status) return;
    managed.status = status;
    this.#post({ type: 'session-status', identity: managed.identity, status });
  }

  /** identity 对应的当前会话；generation 不一致视为不存在 */
  #current(identity: SessionIdentity): ManagedSession | undefined {
    const managed = this.#sessions.get(identity.sessionId);
    return managed?.identity.generation === identity.generation ? managed : undefined;
  }

  #reportMissing(identity: SessionIdentity, command: string): void {
    const current = this.#sessions.get(identity.sessionId);
    if (current && current.identity.generation > identity.generation) {
      this.#log(
        'info',
        `dropped stale ${command} for ${identity.sessionId} (generation ${identity.generation} < ${current.identity.generation})`
      );
      return;
    }
    // Main 以为会话在跑而 worker 里没有：报 fatal，Main 下次使用前重新 spawn
    this.#post({
      type: 'session-error',
      identity,
      error: 'the session is not running in the agent worker',
      fatal: true,
    });
  }

  #log(level: LogLevel, message: string): void {
    this.#post({ type: 'log', level, message });
  }
}
