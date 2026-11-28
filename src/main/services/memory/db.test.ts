import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadSqlite } from '../providers/import/fixtures';
import { MEMORY_DB_VERSION, type MemoryDb, openMemoryDb } from './db';

let dir: string;
const opened: MemoryDb[] = [];

beforeAll(loadSqlite);
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function open(path: string) {
  const result = await openMemoryDb(path, () => 1234);
  if (result.ok) opened.push(result.db);
  return result;
}

describe('openMemoryDb', () => {
  it('新建库：迁移到 v1，四张表都在，pragma 生效；再次打开不重复迁移', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fynvra-memory-db-'));
    const path = join(dir, 'memory', 'memory.db');
    const first = await open(path);
    if (!first.ok) throw new Error(first.error);
    const { db } = first;
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MEMORY_DB_VERSION });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'memories',
        'workspace_projects',
        'extraction_jobs',
        'session_cursors',
      ])
    );
    // 类别 CHECK 约束
    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (project_key, category, content, content_hash, source_kind, created_at, updated_at) VALUES ('k', 'bogus', 'c', 'h', 'user', 1, 1)"
        )
        .run()
    ).toThrow();
    db.close();
    opened.length = 0;
    const second = await open(path);
    expect(second.ok).toBe(true);
  });

  it('库损坏：改名为 corrupt-<时间戳>，新建空库并迁移', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'fynvra-memory-db-'));
    const path = join(dir, 'memory.db');
    writeFileSync(path, 'this is definitely not a sqlite database file'.repeat(50));
    const result = await open(path);
    if (!result.ok) throw new Error(result.error);
    expect(readdirSync(dir)).toContain('memory.db.corrupt-1234');
    expect(existsSync(path)).toBe(true);
    expect(result.db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: MEMORY_DB_VERSION,
    });
  });

  it('版本高于代码所知：不可用，不改名、不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'fynvra-memory-db-'));
    const path = join(dir, 'memory.db');
    const { DatabaseSync } = await loadSqlite();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const result = await open(path);
    expect(result.ok).toBe(false);
    expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(false);
  });
});
