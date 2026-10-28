import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ApprovalMode,
  getBuiltinRole,
  isApprovalMode,
  isThinkingLevel,
  isValidRoleId,
} from '@fynvra/core';
import { asRecord, isNonEmptyString } from '@shared/guards';
import { isSessionStatus } from '@shared/types/agent';
import type { SessionStatus, SessionSummary } from '@shared/types/chat';
import { parseWorkspaceId } from '@shared/types/workspace';

export const SESSIONS_FILE_VERSION = 1;
export const SESSIONS_WRITE_DEBOUNCE_MS = 300;

/**
 * sessions.json 里的一条记录：SessionSummary 加 Main 内部字段（不经 IPC 暴露）。
 * 分支不在记录里：每次由 Main 读 git 现给。
 */
export interface StoredSession extends Omit<SessionSummary, 'branch'> {
  /** 标题仍是创建时的默认值：第一条 prompt 到达时换成它的摘要 */
  autoTitle?: boolean;
}

export interface SessionStore {
  /** 某工作区的会话，最近更新的在前；不含内部字段 */
  list(workspaceId: string): SessionSummary[];
  /** True/false only when the loaded registry can establish existence; unreadable data is unknown */
  exists(id: string): boolean | undefined;
  get(id: string): StoredSession | undefined;
  all(): StoredSession[];
  /** 新增或整条替换 */
  put(session: StoredSession): void;
  /**
   * 合并更新；不存在返回 undefined。状态变成 running 时一并清掉归档：用户在归档的会话里发了消息，
   * 或主 agent 打回 / 发消息给归档的 worker，它就回到会话列表。
   */
  update(id: string, patch: Partial<Omit<StoredSession, 'id'>>): StoredSession | undefined;
  remove(id: string): StoredSession | undefined;
  /** 立即落盘待写内容；失败返回 false 并保留待写状态，下次重试 */
  flush(): boolean;
}

export interface SessionStoreOptions {
  filePath: string;
  debounceMs?: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 会话 id 是 Main 生成的不透明 token，同时用作 jsonl 文件名：其余形状（尤其路径）一律拒绝 */
export function parseSessionId(raw: unknown): string | null {
  return typeof raw === 'string' && SESSION_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * 会话注册表 `userData/sessions.json`（Main 唯一写入者）：内存快照 + 防抖 + 原子替换。
 * 会话正文不在这里，权威源是 pi jsonl。
 */
export function createSessionStore({
  filePath,
  debounceMs = SESSIONS_WRITE_DEBOUNCE_MS,
}: SessionStoreOptions): SessionStore {
  const raw = readJson(filePath);
  const parsed = parseSessionsFile(raw);
  // A partial/corrupt registry must never make orchestration declare workers missing.
  const entries = asRecord(raw)?.sessions;
  const complete =
    asRecord(raw)?.version === SESSIONS_FILE_VERSION &&
    Array.isArray(entries) &&
    entries.length === parsed.length;
  const sessions = new Map<string, StoredSession>(parsed.map((session) => [session.id, session]));
  const removed = new Set<string>();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = (): boolean => {
    if (!dirty) return true;
    try {
      const content = { version: SESSIONS_FILE_VERSION, sessions: [...sessions.values()] };
      writeAtomic(filePath, `${JSON.stringify(content, null, 2)}\n`);
      dirty = false;
      return true;
    } catch (error) {
      console.error('[sessions] 写入 sessions.json 失败', error);
      return false;
    }
  };

  const schedule = () => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      write();
    }, debounceMs);
  };

  return {
    list(workspaceId) {
      return [...sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(toSummary);
    },
    exists: (id) => (sessions.has(id) ? true : complete || removed.has(id) ? false : undefined),
    get: (id) => sessions.get(id),
    all: () => [...sessions.values()],
    put(session) {
      sessions.set(session.id, session);
      schedule();
    },
    update(id, patch) {
      const current = sessions.get(id);
      if (!current) return undefined;
      const { archivedAt, ...rest } = { ...current, ...patch, id };
      const next: StoredSession =
        archivedAt === undefined || patch.status === 'running' ? rest : { ...rest, archivedAt };
      sessions.set(id, next);
      schedule();
      return next;
    },
    remove(id) {
      const current = sessions.get(id);
      if (!current) return undefined;
      sessions.delete(id);
      removed.add(id);
      schedule();
      return current;
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return write();
    },
  };
}

/** IPC 视图：去掉内部字段 */
export function toSummary({ autoTitle: _autoTitle, ...summary }: StoredSession): SessionSummary {
  return summary;
}

/**
 * 磁盘数据收窄：不合法或重复 id 的记录丢弃，未知字段丢弃。永不抛异常。
 * running / waiting-approval 撑不过应用重启（worker 进程已经没了），读入时回到 idle。
 */
export function parseSessionsFile(raw: unknown): StoredSession[] {
  const entries = asRecord(raw)?.sessions;
  if (!Array.isArray(entries)) return [];
  const sessions: StoredSession[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const session = parseStoredSession(entry);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  return sessions;
}

function parseStoredSession(raw: unknown): StoredSession | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = parseSessionId(record.id);
  const workspaceId = parseWorkspaceId(record.workspaceId);
  const { roleId, title, cwd, status, createdAt, updatedAt } = record;
  if (!id || !workspaceId || !isValidRoleId(roleId) || typeof title !== 'string') return null;
  if (!isNonEmptyString(cwd) || !isSessionStatus(status)) return null;
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const session: StoredSession = {
    id,
    workspaceId,
    roleId,
    title,
    cwd,
    status: restoredStatus(status),
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    approvalMode: storedApprovalMode(record.approvalMode, roleId),
  };
  for (const key of ['worktreeId', 'parentSessionId', 'dispatchId'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!isNonEmptyString(value)) return null;
    session[key] = value;
  }
  if (record.model !== undefined) {
    const model = asRecord(record.model);
    if (!isNonEmptyString(model?.providerId) || !isNonEmptyString(model?.modelId)) return null;
    // 不认识的档位（如更新版本写的）只丢档位，不丢会话：回到模型的默认档位
    const { thinking } = model;
    session.model = {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(isThinkingLevel(thinking) ? { thinking } : {}),
    };
  }
  // 归档时间读不懂只丢时间（回到会话列表），不丢会话
  if (Number.isFinite(record.archivedAt)) session.archivedAt = record.archivedAt as number;
  if (record.autoTitle === true) session.autoTitle = true;
  return session;
}

function restoredStatus(status: SessionStatus): SessionStatus {
  return status === 'running' || status === 'waiting-approval' ? 'idle' : status;
}

/**
 * 早于会话级审批档位的记录没有这个字段（当时每次 spawn 都取角色的档位）。内置角色的档位是固定的，照取；
 * 自定义角色要读角色文件才知道，这里 fail-closed 取 supervised（用户可在输入框里再切）。不认识的值同样处理。
 */
function storedApprovalMode(raw: unknown, roleId: string): ApprovalMode {
  if (isApprovalMode(raw)) return raw;
  return getBuiltinRole(roleId)?.approvalMode ?? 'supervised';
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { version: SESSIONS_FILE_VERSION, sessions: [] }
      : undefined;
  }
}

/** 先写同目录临时文件再 rename 覆盖：进程中途崩溃也不会留下半截 sessions.json */
function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
