/**
 * Fynvra 领域模型（docs/ARCHITECTURE.md §4）与会话事件（§5）。字段名是跨包契约：改动前先改 ARCHITECTURE.md。
 * @packageDocumentation
 */

/** 兼容旧字段值的操作通知范围：supervised 全部操作，auto-edits 命令与 MCP，full 仅重点动作；均无需人工放行。 */
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';

/** 会话可用工具集：`all` pi 默认工具 + worker 工具；`readonly` 只读工具；`orchestrator` 只读 + 编排工具。 */
export type ToolPolicy = 'all' | 'readonly' | 'orchestrator';

/**
 * 模型思考档位，由低到高；与 pi 的档位同一组（含 `max`）。每个模型实际可选哪些由 pi 的模型目录决定。
 * OpenAI 把「关闭」叫 `none`：外部输入经 `normalizeThinkingLevel` 归一为 `off`。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 角色 = 系统提示词 + 技能 + MCP + 模型 / 思考档位 + 工具策略 + 通知范围，每个 agent 会话挂一个。 */
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
  /** 工具策略。 */
  tools: ToolPolicy;
  /** 操作通知范围，保留旧字段名。 */
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
  /** 合并时固定的 worker 差异范围；不依赖 worktree 目录或分支仍存在。 */
  mergedDiff?: { baseCommit: string; headCommit: string };
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

/** Magic Context 交给宿主的回退原因；只用于非阻塞提示，不把会话标记为失败。 */
export type MagicContextFallbackReason = 'startup' | 'runtime' | 'context' | 'budget';

/** 单向工具操作通知；不含原始参数、命令或路径，不代表工具已成功执行。 */
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
      /** 旧版本兼容：消费端忽略，不能重建人工审批或重放工具。 */
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
  | { type: 'error'; source: 'model' | 'compaction' | 'host'; message: string };

/** 每条事件带递增 `seq`（从 1 开始）；消费方丢弃过期 seq。 */
export type FynvraSessionEvent = FynvraSessionEventBody & { seq: number };
