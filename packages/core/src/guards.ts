import type {
  ApprovalMode,
  Dispatch,
  MessageType,
  TaskStatus,
  ThinkingLevel,
  ToolPolicy,
} from './types';

/** 结算结果：{@link Dispatch.outcome} 的取值。 */
export type DispatchOutcome = NonNullable<Dispatch['outcome']>;

// Record 键强制穷举联合类型：§4 加了成员而这里没加会编译失败。
const APPROVAL_MODE_SET: Record<ApprovalMode, true> = {
  supervised: true,
  'auto-edits': true,
  full: true,
};
const TOOL_POLICY_SET: Record<ToolPolicy, true> = { all: true, readonly: true, orchestrator: true };
const THINKING_LEVEL_SET: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
};
const TASK_STATUS_SET: Record<TaskStatus, true> = {
  todo: true,
  'in-progress': true,
  'in-review': true,
  completed: true,
  failed: true,
  abandoned: true,
};
const MESSAGE_TYPE_SET: Record<MessageType, true> = {
  worker_done: true,
  question: true,
  reply: true,
  escalation: true,
  heartbeat: true,
  instruction: true,
};
const DISPATCH_OUTCOME_SET: Record<DispatchOutcome, true> = { succeeded: true, failed: true };

function membersOf<T extends string>(set: Record<T, true>): readonly T[] {
  return Object.freeze(Object.keys(set) as T[]);
}

function memberGuard<T extends string>(set: Record<T, true>): (value: unknown) => value is T {
  return (value: unknown): value is T => typeof value === 'string' && Object.hasOwn(set, value);
}

/** 全部 {@link ApprovalMode}，按 §4 声明顺序。 */
export const APPROVAL_MODES = membersOf(APPROVAL_MODE_SET);
/** 全部 {@link ToolPolicy}，按 §4 声明顺序。 */
export const TOOL_POLICIES = membersOf(TOOL_POLICY_SET);
/** 全部 {@link ThinkingLevel}，按 §4 声明顺序。 */
export const THINKING_LEVELS = membersOf(THINKING_LEVEL_SET);
/** 全部 {@link TaskStatus}，按 §4 声明顺序。 */
export const TASK_STATUSES = membersOf(TASK_STATUS_SET);
/** 全部 {@link MessageType}，按 §4 声明顺序。 */
export const MESSAGE_TYPES = membersOf(MESSAGE_TYPE_SET);
/** 全部 {@link DispatchOutcome}。 */
export const DISPATCH_OUTCOMES = membersOf(DISPATCH_OUTCOME_SET);

/** `value` 是否为合法 {@link ApprovalMode}。 */
export const isApprovalMode = memberGuard(APPROVAL_MODE_SET);
/** `value` 是否为合法 {@link ToolPolicy}。 */
export const isToolPolicy = memberGuard(TOOL_POLICY_SET);
/** `value` 是否为合法 {@link ThinkingLevel}。 */
export const isThinkingLevel = memberGuard(THINKING_LEVEL_SET);
/** `value` 是否为合法 {@link TaskStatus}。 */
export const isTaskStatus = memberGuard(TASK_STATUS_SET);
/** `value` 是否为合法 {@link MessageType}。 */
export const isMessageType = memberGuard(MESSAGE_TYPE_SET);
/** `value` 是否为合法 {@link DispatchOutcome}。 */
export const isDispatchOutcome = memberGuard(DISPATCH_OUTCOME_SET);
