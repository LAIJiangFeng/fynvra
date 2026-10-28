// @fynvra/agent-runtime：pi SDK 封装、fynvra 工具与事件归一化（纯 Node，不依赖 Electron）。
// §4 领域类型与会话事件类型以 @fynvra/core 为准；事件类型经 events/normalize 继续从这里导出。

export {
  APPROVAL_TIMEOUT_DEFAULT_MS,
  type ApprovalGate,
  type ApprovalGateOptions,
  type ApprovalGateRequest,
  type ApprovalPolicyHooks,
  type ApprovalRequestFn,
  createApprovalGate,
  type GatedToolCall,
  type NamedInlineExtension,
  type ToolCallBlock,
} from './approval/gate';
export {
  APPROVAL_ARGS_PREVIEW_CHARS,
  type ApprovalDecision,
  type ApprovalKind,
  approvalKindOf,
  describeToolCall,
  modeNotifiesOperation,
  modeRequiresApproval,
  type ToolCallDescription,
} from './approval/policy';
export { protectedAction } from './approval/protectedCommand';
export {
  createEventNormalizer,
  type EventNormalizer,
  type FynvraSessionEvent,
  type FynvraSessionEventBody,
  type NormalizedSubscription,
  type NormalizerStats,
  type SubscribeNormalizedOptions,
  subscribeNormalized,
  TOOL_OUTPUT_PREVIEW_CHARS,
} from './events/normalize';
export { type ExecFn, type ExecOptions, type ExecResult, nodeExec } from './exec';
export {
  type CleanupWorktreeInput,
  type CleanupWorktreeOutput,
  type DispatchOutcome,
  type DispatchRef,
  type DispatchTaskInput,
  type DispatchTaskOutput,
  type HostResult,
  type ListWorkersOutput,
  type MergeWorktreeOutput,
  ORCHESTRATION_TOOL_METHODS,
  type OrchestrationHost,
  type OrchestrationToolName,
  type ReadWorkerOutputInput,
  type ReadWorkerOutputOutput,
  type RejectWorkInput,
  type RejectWorkOutput,
  type ReviewDiffOutput,
  type RunChecksInput,
  type RunChecksOutput,
  type SendToWorkerInput,
  type SendToWorkerOutput,
  type WaitForWorkersInput,
  type WaitForWorkersOutput,
  type WaitUntil,
  type WorkerEntry,
  type WorkerHost,
} from './host';
export type { McpServerConfig } from './pi/mcp';
export {
  buildRolePromptAppend,
  ORCHESTRATOR_PROMPT,
  WORKER_CONTRACT_PROMPT,
} from './prompts/orchestratorPrompt';
export {
  type CreateRoleSessionOptions,
  createRoleSession,
  type ResolvedModel,
  type RoleResourcePaths,
  type RoleSession,
} from './session/createRoleSession';
export {
  CHECK_OUTPUT_MAX_CHARS,
  createOrchestrationTools,
  DEFAULT_ROLE_ID,
  DIFF_MAX_CHARS,
  type OrchestrationToolsOptions,
  type RoleOption,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  WAIT_TIMEOUT_MIN_MS,
  WORKER_OUTPUT_PAGE_CHARS,
} from './tools/orchestrationTools';
export {
  checkGitArgs,
  createGitReadonlyTool,
  createReadonlyTools,
  GIT_OUTPUT_MAX_CHARS,
  GIT_READONLY_SUBCOMMANDS,
  type GitArgsCheck,
  type ReadonlyToolsOptions,
} from './tools/readonlyTools';
export {
  ASK_TIMEOUT_DEFAULT_MS,
  createWorkerTools,
  type WorkerToolset,
  type WorkerToolsOptions,
} from './tools/workerTools';
