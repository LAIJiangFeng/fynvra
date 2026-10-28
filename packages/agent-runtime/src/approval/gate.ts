import type {
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { ApprovalMode, ToolOperationNotice } from '@fynvra/core';
import {
  type ApprovalDecision,
  type ApprovalKind,
  approvalKindOf,
  commandOf,
  modeNotifiesOperation,
} from './policy';
import { protectedAction } from './protectedCommand';

/** @deprecated 仅保留旧调用方的类型兼容；不再创建审批计时器。 */
export const APPROVAL_TIMEOUT_DEFAULT_MS = 10 * 60_000;

/** @deprecated 旧人工审批请求形状；新通知不携带 args / detail。 */
export interface ApprovalGateRequest {
  toolCallId: string;
  toolName: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  args: unknown;
  protectedAction?: string;
  expiresAt: number;
}

/** @deprecated 人工审批通道不再由工具执行路径调用。 */
export type ApprovalRequestFn = (
  request: ApprovalGateRequest,
  signal: AbortSignal
) => Promise<ApprovalDecision>;

/** 保留 approval 名称兼容会话接线；只有 notify 参与工具执行路径。 */
export interface ApprovalPolicyHooks {
  /** 单向通知；返回的 Promise 不等待，发送失败不阻塞执行。 */
  notify?: (notice: ToolOperationNotice) => void | Promise<void>;
  /** @deprecated 旧调用方兼容；gate 不调用它。 */
  request: ApprovalRequestFn;
  /** @deprecated 不再等待人工答复。 */
  timeoutMs?: number;
  /** @deprecated 通知没有审批有效期。 */
  now?: () => number;
  onGate?: (gate: ApprovalGate) => void;
}

export interface ApprovalGateOptions extends ApprovalPolicyHooks {
  mode: ApprovalMode;
}

export interface GatedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallBlock {
  block: true;
  reason: string;
}

export type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

export interface ApprovalGate {
  /** 仅中止的回合在此拒绝；实际工具 / host 仍负责权限和参数校验。 */
  check(call: GatedToolCall, signal?: AbortSignal): Promise<ToolCallBlock | undefined>;
  readonly extension: NamedInlineExtension;
  /** 兼容旧字段：只选择通知范围，不改变工具权限。 */
  readonly mode: ApprovalMode;
  setMode(mode: ApprovalMode): void;
}

/**
 * 在 tool_call 上单向通知后继续；所有档位（含重点命令）都无需人工确认。
 * 不调用旧 request，不创建等待 / 超时，通知失败或未完成均不影响工具。
 */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  let mode = options.mode;

  async function check(
    call: GatedToolCall,
    signal?: AbortSignal
  ): Promise<ToolCallBlock | undefined> {
    if (signal?.aborted) {
      return { block: true, reason: 'The run was stopped; the tool was not run.' };
    }
    const kind = approvalKindOf(call.toolName);
    if (!kind) return undefined;
    const command = kind === 'command' ? commandOf(call.input) : undefined;
    const important = command === undefined ? undefined : protectedAction(command);
    if (!important && !modeNotifiesOperation(mode, kind)) return undefined;
    try {
      // 只有固定工具标签与动作类别跨越通知边界；不传命令、路径或参数。
      const pending = options.notify?.({
        toolCallId: call.toolCallId,
        toolName: kind === 'mcp' ? 'mcp' : call.toolName,
        kind,
      });
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch {
      // 通知只是旁路；窗口 / Main 关闭或通知错误都不产生人工等待。
    }
    // 保留通知钩子同步执行期间的 Stop。
    return signal?.aborted
      ? { block: true, reason: 'The run was stopped; the tool was not run.' }
      : undefined;
  }

  const extension: NamedInlineExtension = {
    name: 'fynvra-tool-notices',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', (event, ctx) =>
        check(
          { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
          runSignal(ctx)
        )
      );
    },
  };

  const gate: ApprovalGate = {
    check,
    extension,
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
  };
  options.onGate?.(gate);
  return gate;
}

/** pi 的 ctx 在会话替换 / 重载后可能失效。 */
function runSignal(ctx: ExtensionContext): AbortSignal | undefined {
  try {
    return ctx.signal;
  } catch {
    return undefined;
  }
}
