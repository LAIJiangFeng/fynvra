/**
 * 临时副本，Task 02 合并后改为从 @fynvra/core 导入。
 *
 * 字段与 docs/ARCHITECTURE.md §4 完全一致；改字段必须先改契约，再同步两处。
 */

// 角色
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
export type ToolPolicy = 'all' | 'readonly' | 'orchestrator';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface Role {
  id: string; // slug；内置：'orchestrator' | 'worker'
  name: string;
  description?: string;
  builtin?: boolean;
  systemPrompt?: string; // 追加到 pi 系统提示词后（EnsoCode: before_agent_start 追加）
  model?: { providerId: string; modelId: string; thinking?: ThinkingLevel };
  skillIds: string[];
  mcpServerIds: string[];
  tools: ToolPolicy;
  approvalMode: ApprovalMode;
}

// 编排（Orca 语义）：Task 是工作；Dispatch 是一次权威尝试
export type TaskStatus =
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'completed'
  | 'failed'
  | 'abandoned';
export interface Task {
  id: string;
  runId: string;
  title: string;
  spec: string;
  roleId: string;
  status: TaskStatus;
  dependsOn: string[];
}
export interface Dispatch {
  id: string;
  taskId: string;
  workerSessionId: string;
  worktreeId: string;
  branch: string;
  startedAt: number;
  settledAt?: number;
  outcome?: 'succeeded' | 'failed';
  summary?: string;
  filesModified?: string[];
}

// 收件箱消息（worker → coordinator，coordinator → worker）
export type MessageType =
  | 'worker_done'
  | 'question'
  | 'reply'
  | 'escalation'
  | 'heartbeat'
  | 'instruction';
export interface Message {
  id: string;
  runId: string;
  dispatchId?: string;
  from: string;
  to: string;
  type: MessageType;
  subject?: string;
  body: string;
  replyTo?: string;
  createdAt: number;
  ackedAt?: number;
}
