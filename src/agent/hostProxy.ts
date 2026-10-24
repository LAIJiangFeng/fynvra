import type { HostResult, OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { errorMessage } from '@shared/guards';
import type {
  AgentWorkerEvent,
  HostCallResult,
  HostKind,
  SessionIdentity,
} from '@shared/types/agent';

/** 等待类方法（wait_for_workers、ask_coordinator）由 Host 自己按 timeoutMs 返回，代理多等这么久再放弃 */
export const HOST_CALL_GRACE_MS = 60_000;
/** 入参里没有 timeoutMs 的方法的等待上限（run_checks 可能要跑整套测试） */
export const HOST_CALL_DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** 发往 Main 的一次 Host 调用；结果永远是 `{ ok, ... }`，不 reject */
export type HostCall = (
  method: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<HostCallResult>;

export interface HostInvoker {
  /** 发 host-invoke 并等待 host-result；中止、超时、发送失败都 resolve 成 `{ ok: false }` */
  invoke(
    identity: SessionIdentity,
    kind: HostKind,
    method: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<HostCallResult>;
  /** host-result 到达：identity 与发起时一致才结算，返回是否命中 */
  settle(identity: SessionIdentity, callId: string, result: HostCallResult): boolean;
  /** 会话关闭：该 identity 下未完成的调用按失败结束 */
  cancelSession(identity: SessionIdentity, reason: string): void;
  cancelAll(reason: string): void;
  readonly pendingCount: number;
}

export interface HostInvokerOptions {
  /** 单次调用的等待上限，默认见 {@link defaultHostCallTimeout} */
  timeoutFor?: (kind: HostKind, method: string, input: unknown) => number;
}

interface PendingCall {
  identity: SessionIdentity;
  finish(result: HostCallResult): void;
}

/**
 * worker 进程里的 Host 调用表（EnsoCode agentControl 的 requestId 模式）：
 * 每次调用一个进程内唯一的 callId；放弃等待（中止 / 超时）时补发 host-cancel，让 Main 也停下。
 */
export function createHostInvoker(
  post: (event: AgentWorkerEvent) => void,
  options: HostInvokerOptions = {}
): HostInvoker {
  const timeoutFor = options.timeoutFor ?? defaultHostCallTimeout;
  const calls = new Map<string, PendingCall>();
  let counter = 0;

  const failAll = (match: (call: PendingCall) => boolean, reason: string) => {
    for (const call of [...calls.values()]) {
      if (match(call)) call.finish({ ok: false, error: reason });
    }
  };

  return {
    invoke(identity, kind, method, input, signal) {
      if (signal?.aborted) return Promise.resolve({ ok: false, error: `${method} was aborted` });
      counter += 1;
      const callId = String(counter);
      return new Promise<HostCallResult>((resolve) => {
        const timeoutMs = timeoutFor(kind, method, input);
        const finish = (result: HostCallResult) => {
          if (!calls.delete(callId)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const giveUp = (error: string) => {
          if (!calls.has(callId)) return;
          finish({ ok: false, error });
          safePost({ type: 'host-cancel', identity, callId });
        };
        const onAbort = () => giveUp(`${method} was aborted`);
        const timer = setTimeout(
          () => giveUp(`${method} got no answer within ${Math.round(timeoutMs / 1000)} s`),
          timeoutMs
        );
        calls.set(callId, { identity, finish });
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          post({ type: 'host-invoke', identity, callId, kind, method, input });
        } catch (error) {
          finish({ ok: false, error: `${method} could not be sent: ${errorMessage(error)}` });
        }
      });
    },
    settle(identity, callId, result) {
      const call = calls.get(callId);
      if (!call || !sameIdentity(call.identity, identity)) return false;
      call.finish(result);
      return true;
    },
    cancelSession(identity, reason) {
      failAll((call) => sameIdentity(call.identity, identity), reason);
    },
    cancelAll(reason) {
      failAll(() => true, reason);
    },
    get pendingCount() {
      return calls.size;
    },
  };

  function safePost(event: AgentWorkerEvent): void {
    try {
      post(event);
    } catch {
      // 通道已断：Main 那边的调用会随 worker 退出一起中止
    }
  }
}

/** 入参带 timeoutMs 的方法按它加 {@link HOST_CALL_GRACE_MS}，其余用 {@link HOST_CALL_DEFAULT_TIMEOUT_MS} */
export function defaultHostCallTimeout(_kind: HostKind, _method: string, input: unknown): number {
  const timeoutMs = (input as { timeoutMs?: unknown } | null | undefined)?.timeoutMs;
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs + HOST_CALL_GRACE_MS
    : HOST_CALL_DEFAULT_TIMEOUT_MS;
}

function sameIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.sessionId === b.sessionId && a.generation === b.generation;
}

/** Main 回传的结果只校验了 ok / error 的形状，成功时的字段按 Host 契约透传 */
function forward<T extends object>(result: Promise<HostCallResult>): Promise<HostResult<T>> {
  return result as Promise<HostResult<T>>;
}

/** 编排工具背后的 OrchestrationHost：每个方法都转发成一次 host-invoke（kind: 'orchestration'） */
export function orchestrationHostProxy(call: HostCall): OrchestrationHost {
  return {
    dispatchTask: (input, signal) => forward(call('dispatchTask', input, signal)),
    listWorkers: (signal) => forward(call('listWorkers', undefined, signal)),
    waitForWorkers: (input, signal) => forward(call('waitForWorkers', input, signal)),
    readWorkerOutput: (input, signal) => forward(call('readWorkerOutput', input, signal)),
    sendToWorker: (input, signal) => forward(call('sendToWorker', input, signal)),
    reviewDiff: (input, signal) => forward(call('reviewDiff', input, signal)),
    runChecks: (input, signal) => forward(call('runChecks', input, signal)),
    mergeWorktree: (input, signal) => forward(call('mergeWorktree', input, signal)),
    rejectWork: (input, signal) => forward(call('rejectWork', input, signal)),
    cleanupWorktree: (input, signal) => forward(call('cleanupWorktree', input, signal)),
  };
}

/** worker 工具背后的 WorkerHost：位置参数打包成对象转发（kind: 'worker'） */
export function workerHostProxy(call: HostCall): WorkerHost {
  return {
    askCoordinator: (question, timeoutMs, signal) =>
      forward(call('askCoordinator', { question, timeoutMs }, signal)),
    reportDone: (outcome, summary, filesModified) =>
      forward(
        call('reportDone', { outcome, summary, ...(filesModified ? { filesModified } : {}) })
      ),
  };
}
