import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../gitRepository';
import { loadSqlite } from '../providers/import/fixtures';
import { redactSecrets } from '../secrets';
import { type MemoryDb, openMemoryDb } from './db';
import { cachedProjectKey, dirProjectKey, resolveProjectKey } from './projectKey';
import {
  contentHash,
  createMemoryStore,
  MEMORY_PROJECT_LIMIT,
  type MemoryStore,
  MemoryStoreError,
} from './store';

const DAY = 86_400_000;
let dir: string;
let db: MemoryDb;
let clock: number;
let store: MemoryStore;
const SECRET = 'super-secret-value-123';

beforeAll(loadSqlite);
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-memory-store-'));
  const result = await openMemoryDb(join(dir, 'memory.db'));
  if (!result.ok) throw new Error(result.error);
  db = result.db;
  clock = 1_000 * DAY;
  store = createMemoryStore(db, {
    now: () => clock,
    redact: (text) => redactSecrets(text, [SECRET]),
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (content: string, key = 'k', extra = {}) =>
  store.insert(key, { category: 'rule', content, sourceKind: 'agent', ...extra });

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryStoreError ? error.code : String(error);
  }
  return undefined;
};

describe('memory store', () => {
  it('归一化哈希：全角、大小写、空白、句末标点不影响', () => {
    expect(contentHash('Run  PNPM test。')).toBe(contentHash('run pnpm test'));
    expect(contentHash('Ｒｕｎ\tpnpm test!!')).toBe(contentHash('run pnpm test'));
    expect(contentHash('run pnpm test')).not.toBe(contentHash('run pnpm lint'));
  });

  it('写入去密钥；同项目哈希重复报 duplicate，不同项目互不影响', () => {
    const row = add(`token is ${SECRET} here`, 'k', { evidence: `quote ${SECRET}` });
    expect(row.content).toBe('token is [已移除密钥] here');
    expect(row.evidence).toBe('quote [已移除密钥]');
    expect(codeOf(() => add('Token is [已移除密钥] here.'))).toBe('duplicate');
    expect(codeOf(() => add('token is [已移除密钥] here', 'other'))).toBeUndefined();
  });

  it('update 改内容重算哈希，与别的条冲突报错；跨项目 id 当作不存在', () => {
    const a = add('first');
    add('second');
    expect(codeOf(() => store.update('k', a.id, { content: 'Second.' }))).toBe('duplicate');
    expect(store.update('k', a.id, { content: 'first!' }).content).toBe('first!');
    expect(codeOf(() => store.update('other', a.id, { content: 'x' }))).toBe('not-found');
    expect(store.remove('other', a.id)).toBe(false);
  });

  it('每项目 500 条上限，任何状态都算', () => {
    store.transaction(() => {
      for (let i = 0; i < MEMORY_PROJECT_LIMIT; i++) add(`entry ${i}`);
    });
    store.setStatus('k', 1, 'disabled');
    expect(codeOf(() => add('one more'))).toBe('limit');
    expect(codeOf(() => add('one more', 'other'))).toBeUndefined();
  });

  it('过期：active 非 pinned 超期 → expired；使用过的不过期；expired 满 90 天硬删除', () => {
    const old = add('old');
    const used = add('used');
    const pinned = add('pinned', 'k', { pinned: true });
    clock += 20 * DAY;
    store.markUsed('k', [used.id]);
    clock += 10 * DAY;
    expect(store.sweep(28)).toEqual(['k']);
    expect(store.get('k', old.id)?.status).toBe('expired');
    expect(store.get('k', used.id)?.status).toBe('active');
    expect(store.get('k', pinned.id)?.status).toBe('active');
    clock += 89 * DAY;
    store.sweep(365);
    expect(store.get('k', old.id)).toBeDefined();
    clock += 2 * DAY;
    store.sweep(365);
    expect(store.get('k', old.id)).toBeUndefined();
    // 恢复为 active 刷新 updated_at
    store.setStatus('k', used.id, 'disabled', 'stale');
    expect(store.get('k', used.id)?.disabled_reason).toBe('stale');
    const restored = store.setStatus('k', used.id, 'active');
    expect(restored.updated_at).toBe(clock);
    expect(restored.disabled_reason).toBeNull();
  });

  it('清空只删本项目', () => {
    add('a');
    add('b');
    add('c', 'other');
    expect(store.clear('k')).toBe(2);
    expect(store.count('k')).toBe(0);
    expect(store.count('other')).toBe(1);
  });
});

describe('project key', () => {
  const now = () => clock;
  const git =
    (stdout: string | null): GitRunner =>
    async () =>
      stdout === null ? { ok: false, error: 'boom' } : { ok: true, stdout };
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  it('多个根提交排序取第一个，并缓存', async () => {
    const key = await resolveProjectKey(
      db,
      { id: 'w1', path: dir, vcs: 'git' },
      { runGit: git(`${SHA_B}\n${SHA_A}\n`), now }
    );
    expect(key).toBe(`git:${SHA_A}`);
    expect(cachedProjectKey(db, 'w1')).toBe(`git:${SHA_A}`);
  });

  it('解析失败沿用缓存；从未成功过退到 dir 标识且不缓存', async () => {
    const ws = { id: 'w1', path: dir, vcs: 'git' as const };
    const degraded = await resolveProjectKey(db, ws, { runGit: git(null), now });
    expect(degraded).toBe(await dirProjectKey(dir));
    expect(cachedProjectKey(db, 'w1')).toBeUndefined();
    await resolveProjectKey(db, ws, { runGit: git(SHA_A), now });
    expect(await resolveProjectKey(db, ws, { runGit: git(null), now })).toBe(`git:${SHA_A}`);
  });

  it('dir 标识：sha256 前 16 位；Windows 上大小写与斜杠不影响', async () => {
    const a = await dirProjectKey('C:\\Work\\Repo-missing', 'win32');
    const b = await dirProjectKey('c:/work/repo-missing', 'win32');
    expect(a).toBe(b);
    expect(a).toMatch(/^dir:[0-9a-f]{16}$/);
  });

  it('dir → git 换键：搬走条目，哈希冲突的旧条目丢弃；旧键被共用时不换', async () => {
    const plain = { id: 'w1', path: dir, vcs: 'none' as const };
    const dirKey = await resolveProjectKey(db, plain, { runGit: git(null), now });
    expect(cachedProjectKey(db, 'w1')).toBe(dirKey);
    add('shared fact', dirKey);
    const kept = add('only in dir', dirKey);
    add('shared fact', `git:${SHA_A}`);

    // 另一个工作区共用同一 dir 键：不换
    await resolveProjectKey(db, { ...plain, id: 'w2' }, { runGit: git(null), now });
    const gitWs = { ...plain, vcs: 'git' as const };
    expect(await resolveProjectKey(db, gitWs, { runGit: git(SHA_A), now })).toBe(dirKey);

    db.prepare("DELETE FROM workspace_projects WHERE workspace_id = 'w2'").run();
    expect(await resolveProjectKey(db, gitWs, { runGit: git(SHA_A), now })).toBe(`git:${SHA_A}`);
    expect(store.count(dirKey)).toBe(0);
    expect(store.count(`git:${SHA_A}`)).toBe(2);
    expect(store.get(`git:${SHA_A}`, kept.id)?.content).toBe('only in dir');
    expect(cachedProjectKey(db, 'w1')).toBe(`git:${SHA_A}`);
  });
});
