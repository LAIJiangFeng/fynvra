/**
 * Fynvra 领域模型（docs/ARCHITECTURE.md §4）与会话事件（§5）。字段名是跨包契约：改动前先改 ARCHITECTURE.md。
 * @packageDocumentation
 */

import type { WorkflowStep } from './workflows/workflow';

/** 审批档位：supervised 审批命令、写入/编辑与 MCP；auto-edits 自动放行编辑；full 放行普通操作。保护命令任何档位都需确认。 */
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';

/** 会话可用工具集：`all` pi 默认工具 + worker 工具；`readonly` 只读工具；`orchestrator` 只读 + 编排工具。 */
export type ToolPolicy = 'all' | 'readonly' | 'orchestrator';

/**
 * 模型思考档位，由低到高；与 pi 的档位同一组（含 `max`）。每个模型实际可选哪些由 pi 的模型目录决定。
 * OpenAI 把「关闭」叫 `none`：外部输入经 `normalizeThinkingLevel` 归一为 `off`。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 角色 = 系统提示词 + 技能 + MCP + 模型 / 思考档位 + 工具策略 + 审批档位，每个 agent 会话挂一个。 */
export interface Role {
  /** slug；内置：`'orchestrator'` | `'worker'`。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 一句话用途说明。 */
  description?: string;
  /** 内置角色标记，由 id 决定；配置可覆盖，id 固定且不可删除。 */
  builtin?: boolean;
  /** 追加到 pi 系统提示词之后（`before_agent_start`）。 */
  systemPrompt?: string;
  /** 固定模型；缺省时由会话决定。 */
  model?: { providerId: string; modelId: string; thinking?: ThinkingLevel };
  /** 启用的技能 id。 */
  skillIds: string[];
  /** Absent: follow global; null: none; ID: use that instruction file. */
  instructionFileId?: string | null;
  /** 启用的 MCP 服务器 id。 */
  mcpServerIds: string[];
  /** 启用的插件 id；缺省等价于 `[]`（旧角色文件没有该字段）。 */
  pluginIds?: string[];
  /** 工具策略。 */
  tools: ToolPolicy;
  /** 审批档位。 */
  approvalMode: ApprovalMode;
}

/**
 * 工作区的版本控制：`git` 是仓库根目录，编排用 worktree；`none` 是普通目录（不是 git 仓库，
 * 或按普通目录挂入的仓库子目录），worker 直接在目录里改（{@link Dispatch.mode} 为 `in-place`）。
 */
export type WorkspaceVcs = 'git' | 'none';

/** 挂入的本地目录。 */
export interface Workspace {
  id: string;
  /** 展示名。 */
  name: string;
  /** 目录绝对路径（git 工作区是仓库根目录）。 */
  repoPath: string;
  vcs: WorkspaceVcs;
  /** 默认分支（如 `main`）；普通目录没有。 */
  defaultBranch?: string;
}

/** agent 会话的元数据引用；会话正文的权威源是 pi jsonl。 */
export interface SessionRef {
  id: string;
  workspaceId: string;
  roleId: string;
  /** 会话工作目录：仓库根目录或 worktree 路径。 */
  cwd: string;
  /** worker 会话绑定的 worktree。 */
  worktreeId?: string;
  /** 派发它的 orchestrator 会话。 */
  parentSessionId?: string;
}

/** 任务状态。合法迁移见 `canTransitionTask`。 */
export type TaskStatus =
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'completed'
  | 'failed'
  | 'abandoned';

/** 一次编排：命名空间 + coordinator 收件箱，本身不调度 worker。 */
export interface Run {
  id: string;
  workspaceId: string;
  /** 主 agent（orchestrator）会话 id。 */
  coordinatorSessionId: string;
  /** 用户需求的一句话目标。 */
  objective: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
}

/** 一项工作。每次尝试是一个 {@link Dispatch}。 */
export interface Task {
  id: string;
  runId: string;
  title: string;
  /** 任务书正文（Markdown）。 */
  spec: string;
  /** 执行角色；未指定时为 `'worker'`。 */
  roleId: string;
  status: TaskStatus;
  /** 前置任务 id。 */
  dependsOn: string[];
  /** 派发时指定的模型（`modelId` 或 `providerId/modelId`）；缺省按角色 / 主 agent 的模型。 */
  model?: string;
  /** 派发时指定的思考档位；缺省按模型 / 角色 / 主 agent 的默认。 */
  thinking?: ThinkingLevel;
  /** 派发的 Fast 请求（不是生效状态）：true 按协议支持开启，false 关闭继承，缺省保持原默认。 */
  fastMode?: boolean;
  /** 合并时固定的 worker 差异范围；不依赖 worktree 目录或分支仍存在。 */
  mergedDiff?: { baseCommit: string; headCommit: string };
  /** 按工作流派发时的定义快照与进度；普通任务没有。`roleId` 是最近启动的节点的角色。 */
  workflow?: TaskWorkflow;
}

/** 工作流任务的一条节点结算记录。 */
export interface TaskWorkflowHistoryEntry {
  /** 节点 id */
  nodeId: string;
  dispatchId: string;
  outcome: 'succeeded' | 'failed';
  /** worker 的总结，截断到 2000 字 */
  summary: string;
  /** 结算时间（epoch ms） */
  at: number;
}

/** 工作流节点在本轮的运行状态。 */
export type TaskWorkflowNodeStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled';

/**
 * 节点在哪里运行：`integration` 是任务的集成 worktree（普通目录即工作区目录），
 * `isolated` 是从集成 worktree 当前 HEAD 分出的节点 worktree，通过后合回集成 worktree。
 */
export type TaskWorkflowPlacement = 'integration' | 'isolated';

/** 一个节点的运行状态（按 `steps` 顺序，一个节点一条）。 */
export interface TaskWorkflowNodeState {
  /** 节点 id（`WorkflowStep.id`） */
  id: string;
  status: TaskWorkflowNodeStatus;
  /** 本轮的尝试；waiting 时没有 */
  dispatchId?: string;
  placement?: TaskWorkflowPlacement;
  /** 隔离节点的 worktree */
  worktreeId?: string;
  /** 隔离节点通过后是否已合回集成 worktree；集成节点没有该字段 */
  merged?: boolean;
  /** waiting：下次启动时写进任务书的退回 / 审查反馈 */
  feedback?: string;
  /** failed：失败原因（worker 总结、合并冲突、启动失败），截断到 2000 字 */
  failure?: string;
}

/** 启动意图：已决定启动、会话还没落库的节点（先落库意图再启动，崩溃恢复用）。 */
export interface TaskWorkflowLaunch {
  nodeId: string;
  /** 预先分配的 dispatch id：store 里已有它就说明已经启动过，不再重复启动 */
  dispatchId: string;
  placement: TaskWorkflowPlacement;
  /** 隔离节点已建好的 worktree（建好就落库，恢复时复用） */
  worktreeId?: string;
}

/** 派发时快照进 Task 的工作流定义，加上推进状态。 */
export interface TaskWorkflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  maxRounds: number;
  /** 已回退次数 */
  rounds: number;
  /** 各节点的运行状态，与 `steps` 一一对应 */
  nodes: TaskWorkflowNodeState[];
  /** 待启动的节点 */
  launches: TaskWorkflowLaunch[];
  /** 集成 worktree（git 工作区）；普通目录没有 */
  worktreeId?: string;
  /** 最近 30 条节点结算 */
  history: TaskWorkflowHistoryEntry[];
}

/**
 * 一次权威的任务尝试：一个 worker 会话 + 一个 worktree。`settledAt` 有值即已结算。
 * 普通目录工作区（`vcs: 'none'`）的尝试 `mode` 为 `in-place`：worker 直接在工作区目录里干活，
 * 没有 worktree 和分支，`worktreeId` 与 `branch` 为空串。
 */
export interface Dispatch {
  id: string;
  taskId: string;
  workerSessionId: string;
  worktreeId: string;
  branch: string;
  /** 缺省是 worktree 模式。 */
  mode?: 'in-place';
  /**
   * 工作流节点 id；只有工作流引擎为节点起的尝试才有。同一任务下 `nodeId` 互不相同的节点尝试可以同时未结算。
   */
  nodeId?: string;
  /** 开始时间（epoch ms）。 */
  startedAt: number;
  /** 结算时间（epoch ms）；缺省表示仍在进行。 */
  settledAt?: number;
  outcome?: 'succeeded' | 'failed';
  /** worker 的 `report_done` 总结。 */
  summary?: string;
  /** worker 报告的改动文件。 */
  filesModified?: string[];
}

/** fynvra 托管的 git worktree。 */
export interface Worktree {
  id: string;
  workspaceId: string;
  /** worktree 目录绝对路径。 */
  path: string;
  /** 检出的分支（`fynvra/<slug>`）。 */
  branch: string;
  /** 创建时指定的基准引用（如 `main`）。 */
  baseRef: string;
  /** 创建时 `baseRef` 解析出的提交。 */
  baseCommit: string;
}

/** 收件箱消息类型。 */
export type MessageType =
  | 'worker_done'
  | 'question'
  | 'reply'
  | 'escalation'
  | 'heartbeat'
  | 'instruction';

/** 收件箱消息（worker → coordinator，coordinator → worker）。 */
export interface Message {
  id: string;
  runId: string;
  /** 关联的尝试。 */
  dispatchId?: string;
  /** 发送方会话 id。 */
  from: string;
  /** 接收方会话 id。 */
  to: string;
  type: MessageType;
  subject?: string;
  body: string;
  /** 回复的消息 id（`reply` 指向对应的 `question`）。 */
  replyTo?: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
  /** 确认时间（epoch ms）；缺省表示未确认。 */
  ackedAt?: number;
}

/** Magic Context 暂停原因；沿用既有事件枚举，供固定恢复提示使用，不包含 provider 原文。 */
export type MagicContextFallbackReason = 'startup' | 'runtime' | 'context' | 'budget';

/** Transport-only lifecycle metadata; never contains prompts, summaries or credentials. */
export interface CompactionState {
  operationId: string;
  reason: 'manual' | 'threshold' | 'overflow';
  phase: 'running' | 'backoff' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  deadlineAt: number;
  attempt: number;
  maxAttempts: number;
  endedAt?: number;
  durationMs?: number;
  cancelSource?: 'user' | 'timeout' | 'shutdown' | 'exception' | 'sdk';
  errorMessage?: string;
}
export interface RetryState {
  kind: 'model' | 'summarization';
  phase: 'backoff' | 'running' | 'finished';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  success?: boolean;
}
export interface ContextRuntimeSnapshot {
  configuredStrategy: 'native' | 'magic-context' | 'off';
  effectiveStrategy: 'native' | 'magic-context' | 'off';
  compactionTimeoutMs: number;
  context: {
    tokens: number | null;
    contextWindow: number;
    source: 'sdk' | 'unknown';
    compactionThresholdTokens?: number;
  };
  compaction?: CompactionState;
  retry?: RetryState;
  recoveryRequired: boolean;
  pendingPromptCount: number;
}

/** 历史兼容的单向工具操作通知；不含原始参数、命令或路径，不代表执行授权或成功。 */
export interface ToolOperationNotice {
  toolCallId: string;
  /** 固定内置工具名；MCP 统一为 mcp，避免带出服务器配置。 */
  toolName: string;
  kind: 'command' | 'file-edit' | 'file-write' | 'mcp';
}

/**
 * 归一化后的会话事件（不含 seq），由 agent-runtime 从 pi 会话事件映射而来。
 * Renderer 只持有投影，会话正文权威源是 pi jsonl。
 */
export type FynvraSessionEventBody =
  | { type: 'context_runtime'; snapshot: ContextRuntimeSnapshot }
  | { type: 'compaction'; state: CompactionState }
  | { type: 'retry'; state: RetryState }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
      parentToolCallId?: string;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      output: string;
      outputTruncated: boolean;
      durationMs?: number;
      parentToolCallId?: string;
    }
  | {
      type: 'message_end';
      role: 'user' | 'assistant';
      text: string;
      stopReason?: string;
      errorMessage?: string;
    }
  | { type: 'agent_settled'; aborted: boolean }
  | ({ type: 'tool_notice' } & ToolOperationNotice)
  | {
      /** pi 没有审批事件：由宿主审批门（tool_call 拦截）经 agent-runtime 的 emit() 注入。 */
      type: 'approval_request';
      requestId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      reason?: string;
    }
  | {
      type: 'usage';
      provider: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      /** 美元，pi 按模型价目计算。 */
      cost: number;
    }
  | {
      /** 非阻塞提示：Magic Context 已把该会话交回 pi 原生压缩；不改变会话状态。 */
      type: 'warning';
      source: 'magic-context';
      reason: MagicContextFallbackReason;
    }
  | { type: 'error'; source: 'model' | 'compaction' | 'host'; message: string }
  | {
      /** Fynvra ran this slash text as a pi extension command instead of a prompt; not in pi jsonl. */
      type: 'command';
      text: string;
    }
  | {
      /** The command finished (or Stop released it) with no agent run active; ephemeral. */
      type: 'command_end';
      aborted: boolean;
    }
  | {
      /** Command output (`ctx.ui.notify` and prompts); ephemeral, not in pi jsonl. */
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      text: string;
    };

/** 每条事件带递增 `seq`（从 1 开始）；消费方丢弃过期 seq。 */
export type FynvraSessionEvent = FynvraSessionEventBody & { seq: number };
