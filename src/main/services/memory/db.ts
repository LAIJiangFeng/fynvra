import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// 项目记忆库（ARCHITECTURE §7.15「存储」）：只有 Main 打开；打开失败不抛给调用方。

export type MemoryDb = InstanceType<typeof import('node:sqlite').DatabaseSync>;

export type MemoryDbOpenResult = { ok: true; db: MemoryDb } | { ok: false; error: string };

/** 迁移数组：下标 i 把库从 user_version i 升到 i+1；每步在事务里执行并写版本号 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('rule', 'workflow', 'pitfall', 'architecture', 'reference')),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired')),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'extraction')),
    source_session_id TEXT,
    source_task_id TEXT,
    source_workspace_id TEXT,
    source_title TEXT,
    evidence TEXT,
    files TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    flagged_at INTEGER,
    flag_note TEXT,
    flagged_by_session TEXT,
    disabled_reason TEXT,
    status_changed_at INTEGER,
    promoted_at INTEGER,
    UNIQUE (project_key, content_hash)
  );
  CREATE INDEX memories_project_status ON memories (project_key, status);
  CREATE TABLE workspace_projects (
    workspace_id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    resolved_at INTEGER NOT NULL
  );
  CREATE INDEX workspace_projects_key ON workspace_projects (project_key);
  CREATE TABLE extraction_jobs (
    job_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'session')),
    project_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    detail TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE session_cursors (
    session_id TEXT PRIMARY KEY,
    last_message_id TEXT,
    last_message_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  `,
];

export const MEMORY_DB_VERSION = MIGRATIONS.length;

/** 在事务里执行；fn 抛错则回滚并照常抛出 */
export function transaction<T>(db: MemoryDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** SQLITE_CORRUPT(11) / SQLITE_NOTADB(26)，含扩展码 */
function isCorrupt(error: unknown): boolean {
  const { errcode, message } = (error ?? {}) as { errcode?: unknown; message?: unknown };
  if (typeof errcode === 'number' && [11, 26].includes(errcode & 0xff)) return true;
  return typeof message === 'string' && /malformed|not a database/i.test(message);
}

function migrate(db: MemoryDb): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version > MIGRATIONS.length) {
    throw new Error(`memory.db 版本 ${version} 高于已知的 ${MIGRATIONS.length}`);
  }
  for (let step = version; step < MIGRATIONS.length; step++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
}

async function openOnce(path: string): Promise<MemoryDb> {
  // 按需加载：Node 23 首次加载 node:sqlite 会打 ExperimentalWarning；Electron 45 的 Node 24.22 不会
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA secure_delete = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    migrate(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // 已经打不开的库关闭失败无所谓
    }
    throw error;
  }
}

function renameCorrupt(path: string, stamp: number): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      renameSync(`${path}${suffix}`, `${path}.corrupt-${stamp}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 打开（必要时新建并迁移）记忆库。损坏时把库连同 -wal / -shm 改名为 `<库>.corrupt-<时间戳>` 后新建；
 * 其他原因打不开返回 `{ ok: false }`，由服务进入不可用状态。
 */
export async function openMemoryDb(
  path: string,
  now: () => number = Date.now
): Promise<MemoryDbOpenResult> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return { ok: true, db: await openOnce(path) };
  } catch (error) {
    if (!isCorrupt(error)) {
      console.warn(`[memory] 打开记忆库失败：${describeError(error)}`);
      return { ok: false, error: describeError(error) };
    }
    try {
      const stamp = now();
      renameCorrupt(path, stamp);
      console.warn(`[memory] 记忆库已损坏，已改名为 ${path}.corrupt-${stamp} 并新建空库`);
      return { ok: true, db: await openOnce(path) };
    } catch (retryError) {
      console.warn(`[memory] 重建记忆库失败：${describeError(retryError)}`);
      return { ok: false, error: describeError(retryError) };
    }
  }
}
