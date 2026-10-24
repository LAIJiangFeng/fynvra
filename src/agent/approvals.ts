import type { ApprovalDecision } from '@shared/types/chat';

interface PendingApproval {
  sessionId: string;
  resolve(decision: ApprovalDecision): void;
}

/**
 * 待审批请求表：审批门发起 request 后挂起，`respond-approval` 命令到达时放行；
 * 超时、会话关闭、中止一律按 deny 结束（审批失败时宁可不执行工具）。
 */
export class ApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>();

  request(sessionId: string, requestId: string, timeoutMs: number): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finish(requestId, 'deny'), timeoutMs);
      this.#pending.set(requestId, {
        sessionId,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  /** 返回是否命中该会话的待审批请求 */
  respond(sessionId: string, requestId: string, decision: ApprovalDecision): boolean {
    if (this.#pending.get(requestId)?.sessionId !== sessionId) return false;
    this.#finish(requestId, decision);
    return true;
  }

  hasPending(sessionId: string): boolean {
    return [...this.#pending.values()].some((pending) => pending.sessionId === sessionId);
  }

  /** 会话关闭或中止：该会话的待审批请求全部 deny */
  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of [...this.#pending]) {
      if (pending.sessionId === sessionId) this.#finish(requestId, 'deny');
    }
  }

  #finish(requestId: string, decision: ApprovalDecision): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    pending.resolve(decision);
  }
}
