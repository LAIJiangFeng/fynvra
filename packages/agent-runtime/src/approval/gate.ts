import type {
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { ApprovalMode } from '@fynvra/core';
import { errorMessage } from '../tools/result';
import {
  type ApprovalDecision,
  type ApprovalKind,
  approvalKindOf,
  commandOf,
  describeToolCall,
  modeRequiresApproval,
} from './policy';
import { protectedAction } from './protectedCommand';

/** 默认等待上限：10 分钟没有答复按 deny（fail-closed） */
export const APPROVAL_TIMEOUT_DEFAULT_MS = 10 * 60_000;
/** setTimeout 能表示的最大延迟 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 审批门交给宿主的一次审批请求 */
export interface ApprovalGateRequest {
  toolCallId: string;
  toolName: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  /** 工具参数原样 */
  args: unknown;
  /** 命中的保护底线（如 `git push`）：任何档位都要人确认，allowSession 不豁免 */
  protectedAction?: string;
  /** epoch ms：到期没有答复按 deny */
  expiresAt: number;
}

/**
 * 请求人工审批。`signal` 在审批门不再等待时 abort（超时、回合被中止），宿主应据此撤下请求。
 * reject 或返回未知值都按 deny 处理。
 */
export type ApprovalRequestFn = (
  request: ApprovalGateRequest,
  signal: AbortSignal
) => Promise<ApprovalDecision>;

/** 宿主提供的审批通道（createRoleSession 的 `approval` 参数） */
export interface ApprovalPolicyHooks {
  request: ApprovalRequestFn;
  /** 等待上限，默认 10 分钟 */
  timeoutMs?: number;
  /** 计算 expiresAt 的时钟，默认 Date.now */
  now?: () => number;
  /**
   * 审批门建好后交给宿主：会话运行中切换档位用（`gate.setMode`）。
   * createRoleSession 在内部建审批门，宿主只能经这里拿到它。
   */
  onGate?: (gate: ApprovalGate) => void;
}

export interface ApprovalGateOptions extends ApprovalPolicyHooks {
  mode: ApprovalMode;
}

/** pi `tool_call` 事件里审批门用到的部分 */
export interface GatedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** pi `tool_call` 的拦截结果：`reason` 就是模型看到的工具结果（错误） */
export interface ToolCallBlock {
  block: true;
  reason: string;
}

/** 带名字的 pi 内联扩展（InlineExtension 的对象形态；函数也有 name，所以用 Exclude 收窄） */
export type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

export interface ApprovalGate {
  /** 放行返回 undefined，拦截返回 block 结果；永不抛异常 */
  check(call: GatedToolCall, signal?: AbortSignal): Promise<ToolCallBlock | undefined>;
  /** 把 check 挂到 pi 的 tool_call 拦截点；signal 取 pi 当前回合的中止信号 */
  readonly extension: NamedInlineExtension;
  /** 当前档位 */
  readonly mode: ApprovalMode;
  /**
   * 换档位，从下一次 check 起生效（回合进行中也可以；已在等答复的请求仍以答复为准）。
   * allowSession 的记忆保留；从 full 切回更严的档位时清空：full 下放行过的，回到要审批的档位要重新问。
   */
  setMode(mode: ApprovalMode): void;
}

type Outcome =
  | { type: 'decision'; decision: ApprovalDecision }
  | { type: 'timeout' }
  | { type: 'aborted' }
  | { type: 'failed'; error: string };

const DECISIONS: ReadonlySet<unknown> = new Set<ApprovalDecision>([
  'allow',
  'allowSession',
  'deny',
]);

/**
 * 在 pi 的 tool_call 上按角色审批档位拦截工具调用：
 * - `supervised` 审批命令、文件写 / 改、MCP 工具；`auto-edits` 只审批命令与 MCP；`full` 全部放行；
 * - 保护底线（rm -rf、git push 等）在任何档位都要人确认，allowSession 也不豁免；
 * - `allowSession` 记住 kind + 工具名，本会话（本审批门）后续同类自动放行；
 * - 档位可以随时用 setMode 切换（会话级设置，初始值是角色的档位）；
 * - fail-closed：超时、回合中止、宿主出错一律拒绝。拒绝以 block 返回可读文本，不抛异常。
 */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const now = options.now ?? Date.now;
  const timeoutMs = validTimeout(options.timeoutMs);
  const sessionAllowed = new Set<string>();
  let mode = options.mode;

  async function check(
    call: GatedToolCall,
    signal?: AbortSignal
  ): Promise<ToolCallBlock | undefined> {
    const kind = approvalKindOf(call.toolName);
    if (!kind) return undefined;
    const command = kind === 'command' ? commandOf(call.input) : undefined;
    const floor = command === undefined ? undefined : protectedAction(command);
    const key = `${kind}:${call.toolName}`;
    if (!floor && (!modeRequiresApproval(mode, kind) || sessionAllowed.has(key))) {
      return undefined;
    }
    const request: ApprovalGateRequest = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      kind,
      ...describeToolCall(call.toolName, kind, call.input),
      args: call.input,
      ...(floor ? { protectedAction: floor } : {}),
      expiresAt: now() + timeoutMs,
    };
    const outcome = await ask(request, signal);
    if (outcome.type === 'decision' && outcome.decision !== 'deny') {
      if (outcome.decision === 'allowSession') sessionAllowed.add(key);
      return undefined;
    }
    return { block: true, reason: refusal(request, outcome, timeoutMs) };
  }

  function ask(request: ApprovalGateRequest, signal: AbortSignal | undefined): Promise<Outcome> {
    if (signal?.aborted) return Promise.resolve({ type: 'aborted' });
    const withdraw = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // 没等到答复就结束：通知宿主撤下这条请求
        if (outcome.type === 'timeout' || outcome.type === 'aborted') withdraw.abort();
        resolve(outcome);
      };
      const onAbort = () => finish({ type: 'aborted' });
      const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      let answer: Promise<ApprovalDecision>;
      try {
        answer = Promise.resolve(options.request(request, withdraw.signal));
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (decision) =>
          finish(
            DECISIONS.has(decision)
              ? { type: 'decision', decision }
              : { type: 'failed', error: `unknown decision ${JSON.stringify(decision)}` }
          ),
        (error: unknown) => finish({ type: 'failed', error: errorMessage(error) })
      );
    });
  }

  const extension: NamedInlineExtension = {
    name: 'fynvra-approval-gate',
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
      if (mode === 'full' && next !== 'full') sessionAllowed.clear();
      mode = next;
    },
  };
  options.onGate?.(gate);
  return gate;
}

/** pi 的 ctx 在会话替换 / 重载后会失效，读 signal 会抛：当作没有中止信号，照常询问 */
function runSignal(ctx: ExtensionContext): AbortSignal | undefined {
  try {
    return ctx.signal;
  } catch {
    return undefined;
  }
}

function validTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return APPROVAL_TIMEOUT_DEFAULT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMER_MS);
}

/** 拒绝时给模型的工具结果：说清拒绝了什么、为什么、工具没有执行、接下来怎么做 */
function refusal(request: ApprovalGateRequest, outcome: Outcome, timeoutMs: number): string {
  const action = describeAction(request);
  const floor = request.protectedAction
    ? ` This is a protected action (${request.protectedAction}) that always needs the user's confirmation.`
    : '';
  switch (outcome.type) {
    case 'timeout':
      return `No approval arrived within ${formatDuration(timeoutMs)}, so ${action} was denied (approvals fail closed) and the tool was not run.${floor} Ask the user before trying again.`;
    case 'aborted':
      return `The approval request for ${action} was cancelled because the run was stopped; the tool was not run.`;
    case 'failed':
      return `Approval for ${action} could not be requested (${outcome.error}), so it was denied and the tool was not run.`;
    default:
      return `The user denied ${action}; the tool was not run.${floor} Do not retry the same call: continue another way or ask the user what they want instead.`;
  }
}

function describeAction(request: ApprovalGateRequest): string {
  const target = request.detail.split('\n')[0]?.trim() ?? '';
  switch (request.kind) {
    case 'command':
      return target ? `the command \`${oneLine(target)}\`` : `the ${request.toolName} call`;
    case 'file-write':
      return target ? `writing ${target}` : `the ${request.toolName} call`;
    case 'file-edit':
      return target ? `editing ${target}` : `the ${request.toolName} call`;
    default:
      return `the MCP tool ${request.toolName}`;
  }
}

function oneLine(text: string): string {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${Math.ceil(ms / 1_000)} seconds`;
}
