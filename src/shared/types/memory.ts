import { asRecord } from '../guards';
import { parseWorkspaceId } from './workspace';

// 项目记忆（docs/ARCHITECTURE.md §7.15）：视图类型与 IPC 入参收窄

export const MEMORY_CATEGORIES = [
  'rule',
  'workflow',
  'pitfall',
  'architecture',
  'reference',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryStatus = 'active' | 'disabled' | 'expired';
export type MemorySourceKind = 'user' | 'agent' | 'extraction';

/** 单条记忆正文上限（字符） */
export const MEMORY_CONTENT_MAX = 500;
/** spawn spec 里注入索引文本的上限（字符） */
export const MEMORY_INDEX_MAX_CHARS = 16000;
/** 过期天数的合法范围（整数） */
export const MEMORY_EXPIRE_DAYS_MIN = 7;
export const MEMORY_EXPIRE_DAYS_MAX = 365;

/** Renderer 列表用的一条记忆；时间都是毫秒时间戳。 */
export interface MemoryView {
  id: number;
  category: MemoryCategory;
  content: string;
  status: MemoryStatus;
  /** 永不过期 */
  pinned: boolean;
  sourceKind: MemorySourceKind;
  sourceTitle?: string;
  sourceTaskId?: string;
  sourceSessionId?: string;
  /** 用户原话或提炼依据 */
  evidence?: string;
  /** 仓库相对路径 */
  files: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  /** worker 报告「可能过时」 */
  flaggedAt?: number;
  flagNote?: string;
  disabledReason?: string;
}

export interface MemoryListView {
  memories: MemoryView[];
  /** 同一项目（同一仓库）被挂入的其他工作区 */
  sharedWithWorkspaceIds: string[];
}

export interface MemoryListInput {
  workspaceId: string;
}
export interface MemoryCreateInput {
  workspaceId: string;
  category: MemoryCategory;
  content: string;
}
export interface MemoryUpdateInput {
  workspaceId: string;
  id: number;
  content?: string;
  category?: MemoryCategory;
  pinned?: boolean;
  status?: 'active' | 'disabled';
}
export interface MemoryRemoveInput {
  workspaceId: string;
  id: number;
}
export type MemoryClearInput = MemoryListInput;

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly unknown[]).includes(value);
}

/** 正文：去首尾空白后 1–500 字符，不含 NUL；非法时 null。 */
export function parseMemoryContent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const content = raw.trim();
  if (content.length < 1 || content.length > MEMORY_CONTENT_MAX) return null;
  return content.includes('\0') ? null : content;
}

function isMemoryId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** 是对象且只有允许的键；否则 null。 */
function strictRecord(raw: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  return Object.keys(record).every((key) => allowed.includes(key)) ? record : null;
}

export function parseMemoryListInput(raw: unknown): MemoryListInput | null {
  const record = strictRecord(raw, ['workspaceId']);
  const workspaceId = parseWorkspaceId(record?.workspaceId);
  return workspaceId ? { workspaceId } : null;
}

export function parseMemoryClearInput(raw: unknown): MemoryClearInput | null {
  return parseMemoryListInput(raw);
}

export function parseMemoryCreateInput(raw: unknown): MemoryCreateInput | null {
  const record = strictRecord(raw, ['workspaceId', 'category', 'content']);
  if (!record) return null;
  const workspaceId = parseWorkspaceId(record.workspaceId);
  const content = parseMemoryContent(record.content);
  if (!workspaceId || !content || !isMemoryCategory(record.category)) return null;
  return { workspaceId, category: record.category, content };
}

/** 至少要改 content / category / pinned / status 其中一项。 */
export function parseMemoryUpdateInput(raw: unknown): MemoryUpdateInput | null {
  const record = strictRecord(raw, [
    'workspaceId',
    'id',
    'content',
    'category',
    'pinned',
    'status',
  ]);
  if (!record) return null;
  const workspaceId = parseWorkspaceId(record.workspaceId);
  if (!workspaceId || !isMemoryId(record.id)) return null;
  const input: MemoryUpdateInput = { workspaceId, id: record.id };
  if (record.content !== undefined) {
    const content = parseMemoryContent(record.content);
    if (!content) return null;
    input.content = content;
  }
  if (record.category !== undefined) {
    if (!isMemoryCategory(record.category)) return null;
    input.category = record.category;
  }
  if (record.pinned !== undefined) {
    if (typeof record.pinned !== 'boolean') return null;
    input.pinned = record.pinned;
  }
  if (record.status !== undefined) {
    if (record.status !== 'active' && record.status !== 'disabled') return null;
    input.status = record.status;
  }
  return Object.keys(input).length > 2 ? input : null;
}

export function parseMemoryRemoveInput(raw: unknown): MemoryRemoveInput | null {
  const record = strictRecord(raw, ['workspaceId', 'id']);
  const workspaceId = parseWorkspaceId(record?.workspaceId);
  if (!workspaceId || !isMemoryId(record?.id)) return null;
  return { workspaceId, id: record.id as number };
}
