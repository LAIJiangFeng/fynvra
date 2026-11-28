import { createHash } from 'node:crypto';
import type {
  MemoryCategory,
  MemorySourceKind,
  MemoryStatus,
  MemoryView,
} from '@shared/types/memory';
import { type MemoryDb, transaction } from './db';

// 记忆条目的增删改查（ARCHITECTURE §7.15「存储」「过期与清理」）。所有写入正文的路径都先经 redact。

/** 每个项目最多条数（任何状态都算） */
export const MEMORY_PROJECT_LIMIT = 500;
export const MEMORY_EVIDENCE_MAX = 300;
const DAY_MS = 86_400_000;
/** expired 条目保留天数，满了硬删除 */
const EXPIRED_KEEP_DAYS = 90;

export interface MemoryRow {
  id: number;
  project_key: string;
  category: MemoryCategory;
  content: string;
  content_hash: string;
  status: MemoryStatus;
  pinned: number;
  source_kind: MemorySourceKind;
  source_session_id: string | null;
  source_task_id: string | null;
  source_workspace_id: string | null;
  source_title: string | null;
  evidence: string | null;
  files: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  flagged_at: number | null;
  flag_note: string | null;
  flagged_by_session: string | null;
  disabled_reason: string | null;
  status_changed_at: number | null;
  promoted_at: number | null;
}

export type MemoryStoreErrorCode = 'not-found' | 'duplicate' | 'limit';

export class MemoryStoreError extends Error {
  constructor(readonly code: MemoryStoreErrorCode) {
    super(code);
  }
}

/** 出处字段（新增与 update 共用） */
export interface MemorySource {
  sourceKind?: MemorySourceKind;
  sourceSessionId?: string;
  sourceTaskId?: string;
  sourceWorkspaceId?: string;
  sourceTitle?: string;
  evidence?: string;
}

export interface NewMemory extends MemorySource {
  category: MemoryCategory;
  content: string;
  sourceKind: MemorySourceKind;
  files?: readonly string[];
  pinned?: boolean;
}

export interface MemoryPatch extends MemorySource {
  category?: MemoryCategory;
  content?: string;
  files?: readonly string[];
  pinned?: boolean;
  /** 清掉 flagged_*（提炼 update / keep 用） */
  clearFlag?: boolean;
}

/** 归一化哈希：NFKC → 小写 → 合并空白 → 去掉句末标点 → sha256 */
export function contentHash(content: string): string {
  const normalized = content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\p{P}\s]+$/u, '');
  return createHash('sha256').update(normalized).digest('hex');
}

/** 最近一次「有效」时间：max(last_used_at, updated_at) */
export const lastTouched = (row: Pick<MemoryRow, 'last_used_at' | 'updated_at'>) =>
  Math.max(row.last_used_at ?? 0, row.updated_at);

export function parseFiles(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((file) => typeof file === 'string') : [];
  } catch {
    return [];
  }
}

const opt = <T>(value: T | null): T | undefined => value ?? undefined;

export function toView(row: MemoryRow): MemoryView {
  const view: MemoryView = {
    id: row.id,
    category: row.category,
    content: row.content,
    status: row.status,
    pinned: row.pinned === 1,
    sourceKind: row.source_kind,
    sourceTitle: opt(row.source_title),
    sourceTaskId: opt(row.source_task_id),
    sourceSessionId: opt(row.source_session_id),
    evidence: opt(row.evidence),
    files: parseFiles(row.files),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: opt(row.last_used_at),
    useCount: row.use_count,
    flaggedAt: opt(row.flagged_at),
    flagNote: opt(row.flag_note),
    disabledReason: opt(row.disabled_reason),
  };
  // 去掉 undefined 键，结构化克隆与快照都干净
  for (const key of Object.keys(view) as (keyof MemoryView)[]) {
    if (view[key] === undefined) delete view[key];
  }
  return view;
}

const clip = (text: string, max: number) => [...text].slice(0, max).join('');

export interface MemoryStoreOptions {
  now: () => number;
  /** 去密钥（同步；已知密钥列表由服务在写入前刷新） */
  redact: (text: string) => string;
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;

export function createMemoryStore(db: MemoryDb, { now, redact }: MemoryStoreOptions) {
  const rows = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).all(...params) as unknown as MemoryRow[];

  const get = (projectKey: string, id: number): MemoryRow | undefined =>
    db.prepare('SELECT * FROM memories WHERE project_key = ? AND id = ?').get(projectKey, id) as
      | MemoryRow
      | undefined;

  const require = (projectKey: string, id: number): MemoryRow => {
    const row = get(projectKey, id);
    if (!row) throw new MemoryStoreError('not-found');
    return row;
  };

  const findByHash = (projectKey: string, hash: string): MemoryRow | undefined =>
    db
      .prepare('SELECT * FROM memories WHERE project_key = ? AND content_hash = ?')
      .get(projectKey, hash) as MemoryRow | undefined;

  const count = (projectKey: string): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key = ?').get(projectKey) as {
        n: number;
      }
    ).n;

  const redactSource = (source: MemorySource) => ({
    title: source.sourceTitle === undefined ? undefined : redact(source.sourceTitle),
    evidence:
      source.evidence === undefined
        ? undefined
        : clip(redact(source.evidence), MEMORY_EVIDENCE_MAX),
  });

  return {
    db,
    redact,
    get,
    findByHash,
    count,
    transaction: <T>(fn: () => T): T => transaction(db, fn),

    /** 本项目全部条目，新的在前 */
    all: (projectKey: string) =>
      rows('SELECT * FROM memories WHERE project_key = ? ORDER BY id DESC', projectKey),

    byStatus: (projectKey: string, status: MemoryStatus) =>
      rows(
        'SELECT * FROM memories WHERE project_key = ? AND status = ? ORDER BY id DESC',
        projectKey,
        status
      ),

    /** 新增：先去密钥再算哈希；哈希重复或满 500 条时抛 MemoryStoreError */
    insert(projectKey: string, memory: NewMemory): MemoryRow {
      const content = redact(memory.content);
      const hash = contentHash(content);
      if (findByHash(projectKey, hash)) throw new MemoryStoreError('duplicate');
      if (count(projectKey) >= MEMORY_PROJECT_LIMIT) throw new MemoryStoreError('limit');
      const source = redactSource(memory);
      const at = now();
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO memories (project_key, category, content, content_hash, status, pinned, source_kind,
             source_session_id, source_task_id, source_workspace_id, source_title, evidence, files,
             created_at, updated_at, use_count, status_changed_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          projectKey,
          memory.category,
          content,
          hash,
          memory.pinned ? 1 : 0,
          memory.sourceKind,
          memory.sourceSessionId ?? null,
          memory.sourceTaskId ?? null,
          memory.sourceWorkspaceId ?? null,
          source.title ?? null,
          source.evidence ?? null,
          JSON.stringify(memory.files ?? []),
          at,
          at,
          at
        );
      return require(projectKey, Number(lastInsertRowid));
    },

    /** 修改：改内容时去密钥并重算哈希，与其他条冲突抛 duplicate */
    update(projectKey: string, id: number, patch: MemoryPatch): MemoryRow {
      const row = require(projectKey, id);
      const sets: string[] = ['updated_at = ?'];
      const params: (string | number | null)[] = [now()];
      const set = (column: string, value: string | number | null) => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (patch.content !== undefined) {
        const content = redact(patch.content);
        const hash = contentHash(content);
        const other = findByHash(projectKey, hash);
        if (other && other.id !== id) throw new MemoryStoreError('duplicate');
        set('content', content);
        set('content_hash', hash);
      }
      if (patch.category !== undefined) set('category', patch.category);
      if (patch.files !== undefined) set('files', JSON.stringify(patch.files));
      if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0);
      const source = redactSource(patch);
      if (patch.sourceKind !== undefined) set('source_kind', patch.sourceKind);
      if (patch.sourceSessionId !== undefined) set('source_session_id', patch.sourceSessionId);
      if (patch.sourceTaskId !== undefined) set('source_task_id', patch.sourceTaskId);
      if (patch.sourceWorkspaceId !== undefined) {
        set('source_workspace_id', patch.sourceWorkspaceId);
      }
      if (source.title !== undefined) set('source_title', source.title);
      if (source.evidence !== undefined) set('evidence', source.evidence);
      if (patch.clearFlag) {
        set('flagged_at', null);
        set('flag_note', null);
        set('flagged_by_session', null);
      }
      db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
      return require(projectKey, id);
    },

    /** 硬删除；不存在返回 false */
    remove: (projectKey: string, id: number): boolean =>
      Number(
        db.prepare('DELETE FROM memories WHERE project_key = ? AND id = ?').run(projectKey, id)
          .changes
      ) > 0,

    /** 记一次使用：last_used_at = now、use_count + 1 */
    markUsed(projectKey: string, ids: readonly number[]): void {
      const stmt = db.prepare(
        'UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE project_key = ? AND id = ?'
      );
      const at = now();
      for (const id of ids) stmt.run(at, projectKey, id);
    },

    /** worker 报告「可能过时」 */
    flag(projectKey: string, id: number, note: string | undefined, sessionId: string): void {
      require(projectKey, id);
      db.prepare(
        'UPDATE memories SET flagged_at = ?, flag_note = ?, flagged_by_session = ? WHERE project_key = ? AND id = ?'
      ).run(now(), note === undefined ? null : redact(note), sessionId, projectKey, id);
    },

    /** 停用 / 恢复：恢复为 active 时刷新 updated_at 并清掉停用原因 */
    setStatus(projectKey: string, id: number, status: MemoryStatus, reason?: string): MemoryRow {
      const row = require(projectKey, id);
      if (row.status !== status) {
        const at = now();
        db.prepare(
          `UPDATE memories SET status = ?, status_changed_at = ?, disabled_reason = ?,
             updated_at = CASE WHEN ? = 'active' THEN ? ELSE updated_at END
           WHERE id = ?`
        ).run(
          status,
          at,
          status === 'disabled' && reason !== undefined ? redact(reason) : null,
          status,
          at,
          id
        );
      }
      return require(projectKey, id);
    },

    /**
     * 过期扫描：active、非 pinned、max(last_used_at, updated_at) 早于 expireDays 天 → expired；
     * expired 满 90 天 → 硬删除。返回有变化的 project_key。
     */
    sweep(expireDays: number): string[] {
      const at = now();
      const expireBefore = at - expireDays * DAY_MS;
      const deleteBefore = at - EXPIRED_KEEP_DAYS * DAY_MS;
      return transaction(db, () => {
        const changed = new Set<string>();
        const stale = db
          .prepare(
            `SELECT id, project_key FROM memories WHERE status = 'active' AND pinned = 0
               AND MAX(COALESCE(last_used_at, 0), updated_at) < ?`
          )
          .all(expireBefore) as { id: number; project_key: string }[];
        const expire = db.prepare(
          "UPDATE memories SET status = 'expired', status_changed_at = ? WHERE id = ?"
        );
        for (const { id, project_key } of stale) {
          expire.run(at, id);
          changed.add(project_key);
        }
        const old = db
          .prepare(
            "SELECT id, project_key FROM memories WHERE status = 'expired' AND COALESCE(status_changed_at, 0) < ?"
          )
          .all(deleteBefore) as { id: number; project_key: string }[];
        const remove = db.prepare('DELETE FROM memories WHERE id = ?');
        for (const { id, project_key } of old) {
          remove.run(id);
          changed.add(project_key);
        }
        return [...changed];
      });
    },

    /** 清空一个项目，然后 checkpoint 把 WAL 里的旧页也清掉 */
    clear(projectKey: string): number {
      const { changes } = db.prepare('DELETE FROM memories WHERE project_key = ?').run(projectKey);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return Number(changes);
    },
  };
}
