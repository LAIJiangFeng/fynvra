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
 * 档位从哪来：
 * - `catalog`：pi 内置目录里同协议、同 id 的模型；
 * - `inferred:<id>`：目录里没有，按「同协议 + 规整后的最长公共 id 前缀」推断为目录里的 `<id>`；
 * - `fallback`：两者都不是，按协议兜底（设置里标了推理才有档位）。
 */
export type ThinkingSource = 'catalog' | 'fallback' | `inferred:${string}`;

const INFERRED_PREFIX = 'inferred:';

/** `value` 是否为合法的 {@link ThinkingSource}：`inferred:` 后面要有不含空白的模型 id */
export function isThinkingSource(value: unknown): value is ThinkingSource {
  if (value === 'catalog' || value === 'fallback') return true;
  return (
    typeof value === 'string' &&
    value.startsWith(INFERRED_PREFIX) &&
    /^\S+$/.test(value.slice(INFERRED_PREFIX.length))
  );
}

/**
 * 一个模型可选的思考档位：worker 按 pi 内置模型目录的 reasoning 与 thinkingLevelMap 算出（含 max）；
 * 目录里没有的模型按目录里最接近的模型推断，推断不出时按协议兜底（看设置里模型条目的 reasoning 标记）。
 */
export interface ModelThinkingCapability {
  /** 由低到高；空数组表示不支持推理，界面不显示档位控件 */
  thinkingLevels: ThinkingLevel[];
  /** 模型的默认档位（pi 的默认 medium 按模型能力 clamp），thinkingLevels 非空时才有 */
  defaultThinking?: ThinkingLevel;
  /** 档位的来源；推断与兜底的，界面在档位旁用小字说明（{@link thinkingSourceNote}） */
  source?: ThinkingSource;
}

/**
 * 生效的思考档位：请求的档位在模型的可选集合里就用它，否则回落到模型的默认档位，
 * 没有可用的默认档位时取列表中间的一档（偶数个取偏低的）；模型不支持推理时没有档位。
 * Renderer 切换模型、worker 创建会话与切换模型都按这一条。
 */
export function pickThinkingLevel(
  capability: ModelThinkingCapability,
  requested?: ThinkingLevel
): ThinkingLevel | undefined {
  const { thinkingLevels, defaultThinking } = capability;
  if (requested && thinkingLevels.includes(requested)) return requested;
  if (defaultThinking && thinkingLevels.includes(defaultThinking)) return defaultThinking;
  return thinkingLevels[Math.floor((thinkingLevels.length - 1) / 2)];
}

/** 档位的显示名：官方等级名（pi 与各家 API 的叫法），off 附上中文；选择器、新建弹层、角色编辑器共用 */
export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: 'off · 关闭',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** 档位的中文说明：悬停时显示 */
export const THINKING_LEVEL_HINTS: Readonly<Record<ThinkingLevel, string>> = {
  off: '关闭思考：不推理，直接回答',
  minimal: '极少思考：只做必要的推理',
  low: '少量思考：回答更快',
  medium: '适中：速度与深度折中',
  high: '深入思考',
  xhigh: '更深入的思考：更慢、更费 token',
  max: '最大思考：不设上限，最慢、最费 token',
};

/** 档位旁的小字：推断来的写明按哪个目录模型推断，兜底的说明目录里没有；目录里有的不写 */
export function thinkingSourceNote(source: ThinkingSource | undefined): string | undefined {
  if (source === 'fallback') return '目录里没有这个模型，按协议兜底';
  if (source?.startsWith(INFERRED_PREFIX)) return `按 ${source.slice(INFERRED_PREFIX.length)} 推断`;
  return undefined;
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
