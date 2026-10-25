import {
  APPROVAL_MODES,
  type ApprovalMode,
  type FynvraSessionEvent,
  type ThinkingLevel,
} from '@fynvra/core'; // 事件类型由 Task 10 挪进 core；src/shared 不得 import agent-runtime
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
  /** 审批档位：创建时取角色的值，之后是会话自己的设置（`sessions:set-approval-mode`，运行中也能切） */
  approvalMode: ApprovalMode;
  /** cwd 当前检出的分支（Main 现读 git，不落盘）；detached 时是短 sha；不是 git 目录或还没读到时没有 */
  branch?: string;
  /** 归档时间（手动归档或闲置扫描）；恢复或会话再次运行时清除。`sessions:list` 默认不列归档的会话 */
  archivedAt?: number;
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

// 审批档位、思考档位的显示名在 Renderer 的字典里（approval.modes.<mode>、thinking.levels.<level>）

/** 输入框里 Shift+Tab 的下一档：supervised → auto-edits → full → supervised */
export function nextApprovalMode(mode: ApprovalMode): ApprovalMode {
  const index = APPROVAL_MODES.indexOf(mode);
  return APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? 'supervised';
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
  /** 档位的来源；推断与兜底的，界面在档位旁标徽标、悬停写明来历（{@link describeThinkingSource}） */
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

/** 要在档位旁标出来的来源：推断来的带上按哪个目录模型推断，兜底的只有类别 */
export type ThinkingSourceInfo = { kind: 'fallback' } | { kind: 'inferred'; model: string };

/**
 * 档位旁徽标与悬停说明的依据（文案在 Renderer 字典的 thinking.source / thinking.sourceNote）：
 * 推断来的与兜底的标出来，目录里有的不标（undefined）。
 */
export function describeThinkingSource(
  source: ThinkingSource | undefined
): ThinkingSourceInfo | undefined {
  if (source === 'fallback') return { kind: 'fallback' };
  if (source?.startsWith(INFERRED_PREFIX)) {
    return { kind: 'inferred', model: source.slice(INFERRED_PREFIX.length) };
  }
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
