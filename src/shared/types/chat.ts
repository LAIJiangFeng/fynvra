import type { FynvraSessionEvent } from '@fynvra/core'; // 事件类型由 Task 10 挪进 core；src/shared 不得 import agent-runtime

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error';
export interface SessionSummary {
  id: string;
  workspaceId: string;
  roleId: string;
  title: string;
  cwd: string;
  worktreeId?: string;
  parentSessionId?: string;
  dispatchId?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  model?: { providerId: string; modelId: string };
}
export type ChatRole = 'user' | 'assistant';
export interface ChatToolCall {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'done' | 'error';
  output?: string;
  durationMs?: number;
}
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  text: string;
  thinking?: string;
  toolCalls: ChatToolCall[];
  createdAt: number;
  streaming: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  expiresAt: number;
}
/** Main → Renderer 推送（通道 `sessions:event`）。 */
export interface SessionEventEnvelope {
  sessionId: string;
  event: FynvraSessionEvent;
}
