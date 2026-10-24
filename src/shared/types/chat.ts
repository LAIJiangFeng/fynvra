import type { FynvraSessionEvent, ThinkingLevel } from '@fynvra/core'; // 事件类型由 Task 10 挪进 core；src/shared 不得 import agent-runtime
import type { ProviderApi } from './llm';

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error';
/**
 * 会话用的模型：「设置 → 模型服务」里的服务 id 与模型 id（只存 id 引用），加思考档位。
 * 档位缺省时 worker 依次取角色的 model.thinking、模型的默认档位（{@link pickThinkingLevel}）。
 */
export interface SessionModelRef {
  providerId: string;
  modelId: string;
  thinking?: ThinkingLevel;
}
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
  model?: SessionModelRef;
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

/**
 * 一个模型可选的思考档位：worker 按 pi 内置模型目录的 reasoning 与 thinkingLevelMap 算出；
 * pi 目录里没有的模型（如自定义 OpenAI 兼容服务）按设置里模型条目的 reasoning 标记。
 */
export interface ModelThinkingCapability {
  /** 由低到高；空数组表示不支持推理，界面不显示档位控件 */
  thinkingLevels: ThinkingLevel[];
  /** 模型的默认档位（pi 的默认 medium 按模型能力 clamp），thinkingLevels 非空时才有 */
  defaultThinking?: ThinkingLevel;
}

/**
 * 生效的思考档位：请求的档位在模型的可选集合里就用它，否则回落到模型的默认档位；
 * 模型不支持推理时没有档位。Renderer 切换模型、worker 创建会话与切换模型都按这一条。
 */
export function pickThinkingLevel(
  capability: ModelThinkingCapability,
  requested?: ThinkingLevel
): ThinkingLevel | undefined {
  const { thinkingLevels, defaultThinking } = capability;
  if (requested && thinkingLevels.includes(requested)) return requested;
  if (defaultThinking && thinkingLevels.includes(defaultThinking)) return defaultThinking;
  return thinkingLevels[0];
}

/** `sessions:model-options` 的一个模型：设置里的模型条目加它的思考档位 */
export interface ModelOption extends ModelThinkingCapability {
  id: string;
  name: string;
}
/** `sessions:model-options` 的一个服务：只列启用且填了 key 的（不带 key 与地址） */
export interface ModelProviderOption {
  providerId: string;
  name: string;
  api: ProviderApi;
  models: ModelOption[];
}
export interface ModelOptions {
  providers: ModelProviderOption[];
  /** 传了 workspaceId 时：该工作区上一次用过的模型（settings.json `preferences.lastModelByWorkspace`） */
  lastUsed?: SessionModelRef;
}
