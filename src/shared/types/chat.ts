import {
  APPROVAL_MODES,
  type ApprovalMode,
  type FynvraSessionEvent,
  type ThinkingLevel,
} from '@fynvra/core'; // 事件类型由 Task 10 挪进 core；src/shared 不得 import agent-runtime
import { asRecord } from '../guards';
import type { ProviderApi } from './llm';

/** waiting-approval 仅用于读取旧记录；新版按实际 live 状态恢复，不再生成。 */
export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error';
/**
 * 会话用的模型：「设置 → 模型服务」里的服务 id 与模型 id（只存 id 引用），加思考档位与 Fast。
 * 档位缺省时 worker 依次取角色的 model.thinking、模型的默认档位（{@link pickThinkingLevel}）。
 * fastMode 是会话自己的请求选项，与档位独立；只对 OpenAI Responses / Chat Completions 生效，缺省关闭。
 */
export interface SessionModelRef {
  providerId: string;
  modelId: string;
  thinking?: ThinkingLevel;
  fastMode?: boolean;
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
  /** 兼容旧字段：操作通知范围，创建时取角色值，可在运行中切换，不改变执行权限。 */
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
/** 输入框能粘贴、能发给 pi 的图片格式 */
export const CHAT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number];
/** 随 user 消息发送的图片。缩放、转码由 pi 在 worker 里做，Renderer 原样发出 */
export interface ChatImage {
  /** base64，不含 `data:` 前缀 */
  data: string;
  mimeType: ChatImageMimeType;
}
/** 每条消息最多几张图片 */
export const MAX_CHAT_IMAGES = 10;
/** 单张图片解码后的上限 */
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
/** 一条消息里图片解码后的合计上限：单条 IPC 远低于 Chromium 约 128 MiB 的消息上限 */
export const MAX_CHAT_IMAGES_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  text: string;
  /** 只用于 user 消息：随消息发送的图片 */
  images?: ChatImage[];
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

/** 输入框灰字回复建议的最长字符数：只放一行短的下一句，不做长文或候选列表 */
export const MAX_REPLY_SUGGESTION_CHARS = 200;
/**
 * 一轮正常结束后生成的一条「用户下一句话」建议。`roundId` 是该轮 settled 事件的会话级 seq，
 * Renderer 只回传它，Main / worker 用它拒绝旧轮或别的会话的回包。建议只存在于 Renderer 内存，
 * 不写入 pi jsonl，也不等于输入框草稿
 */
export interface ReplySuggestion {
  sessionId: string;
  roundId: number;
  text: string;
}

/**
 * 把模型输出收敛成一条可展示的建议：取第一行非空文本，去掉明确的列表 / 标题前缀、
 * 整句外围的引号或成对 Markdown 包裹，压成一行并按 {@link MAX_REPLY_SUGGESTION_CHARS} 截断。
 * 只清理可识别的外围标记，不全局删除 `_`、`*`、`#` 等字符，避免把 `src/foo_bar.ts` 或 `*.ts` 改坏。
 * 空串表示「没有明确建议」。Main 与 worker 都过一遍，不依赖某一端单独清洗。
 */
export function normalizeReplySuggestion(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (!line || line.includes('```')) return '';
  let text = line
    .replace(/^(?:suggestion|reply|建议|回复)\s*[:：]\s*/i, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*•>]|\d+[.)])\s+/, '')
    .trim();
  // 只去整句外围的成对引号；内部内容（包括文件名、标识符）保持原样
  text = text.replace(/^(["'“”‘’])([\s\S]*)\1$/, '$2');
  // 只去整句外围的成对粗体 / 斜体星号；中间或标识符里的 * 不碰
  text = text.replace(/^(\*\*|\*)([\s\S]+)\1$/, '$2');
  // 成对反引号只在包住整句时当作 Markdown 外壳去掉；句中的命令 / 标识符不动
  text = text
    .replace(/^`([^`\n]+)`$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > MAX_REPLY_SUGGESTION_CHARS) {
    text = `${text.slice(0, MAX_REPLY_SUGGESTION_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

export function isChatImageMimeType(value: unknown): value is ChatImageMimeType {
  return (CHAT_IMAGE_MIME_TYPES as readonly unknown[]).includes(value);
}

// 标准 base64（不是 base64url）：不含空白，= 只能在末尾
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64 解码后的字节数，按字符串长度与末尾的 = 算（不解码）；不是合法 base64 时为 null */
export function base64ByteLength(data: string): number | null {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * 一条消息的图片（IPC 入参与 Main → worker 的 prompt 都经它收窄）：1 到 {@link MAX_CHAT_IMAGES} 张；
 * 每张只有 data、mimeType 两个键，格式在白名单里，data 是非空的标准 base64；
 * 解码后单张不超过 {@link MAX_CHAT_IMAGE_BYTES}，合计不超过 {@link MAX_CHAT_IMAGES_TOTAL_BYTES}。
 * 任一张不合法时整组作废。
 */
export function parseChatImages(raw: unknown): ChatImage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHAT_IMAGES) return null;
  const images: ChatImage[] = [];
  let total = 0;
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || Object.keys(record).length !== 2) return null;
    const { data, mimeType } = record;
    if (typeof data !== 'string' || !isChatImageMimeType(mimeType)) return null;
    const bytes = base64ByteLength(data);
    if (!bytes || bytes > MAX_CHAT_IMAGE_BYTES) return null;
    total += bytes;
    if (total > MAX_CHAT_IMAGES_TOTAL_BYTES) return null;
    images.push({ data, mimeType });
  }
  return images;
}

/**
 * pi 收到带图片的 prompt 时，缩放或转换过图片就把提示行接在正文后面：`${正文}\n\n${提示行.join('\n')}`，
 * 如 `[Image: original 3773x1017, displayed at 2000x539. …]`、`[Image converted from image/webp to image/png.]`、
 * `[Image omitted: …]`。它们会出现在 user 的 message_end 与 jsonl 里。
 */
const IMAGE_HINTS = /(?:^|\n\n)\[Image[: ][^\n]*\](?:\n\[Image[: ][^\n]*\])*$/;

/**
 * 去掉 pi 接在末尾的图片提示行（连同前面的空行）；正文只剩提示行时返回空串，正文中间形似提示行的文字保留。
 * 只用于带图片的 user 消息。
 */
export function stripImageHints(text: string): string {
  return text.replace(IMAGE_HINTS, '');
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
