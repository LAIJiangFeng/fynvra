import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionArchive, type WorktreeCleanupOutcome } from './archive';
import { createSessionStore, type SessionStore, type StoredSession } from './sessionStore';

const NOW = 50_000;

function session(patch: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    roleId: 'worker',
    title: 'Worker',
    cwd: 'C:\\repos\\demo',
    status: 'idle',
    createdAt: 1_000,
    updatedAt: 2_000,
    approvalMode: 'auto-edits',
    ...patch,
  };
}

let dir = '';
let store: SessionStore;
let cleanupOnArchive = false;

function make() {
  const deps = {
    store,
    dispose: vi.fn(async (_sessionId: string) => {}),
    cleanupWorktreeOnArchive: () => cleanupOnArchive,
    cleanupWorktree: vi.fn(
      async (_session: StoredSession): Promise<WorktreeCleanupOutcome> => ({ removed: true })
    ),
    changed: vi.fn((_workspaceId: string) => {}),
    now: () => NOW,
    log: vi.fn((_message: string) => {}),
  };
  return { deps, archive: createSessionArchive(deps) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-archive-'));
  store = createSessionStore({ filePath: join(dir, 'sessions.json') });
  cleanupOnArchive = false;
});

afterEach(() => {
  store.flush();
  rmSync(dir, { recursive: true, force: true });
});

describe('archive', () => {
  it('记下归档时间（不改最后更新）、广播、让会话退出 worker', async () => {
    store.put(session({ autoTitle: true }));
    const { deps, archive } = make();
    const result = await archive.archive('session-1');
    expect(result).toEqual({
      ok: true,
      session: { ...session(), archivedAt: NOW },
    });
    expect(store.get('session-1')).toMatchObject({ archivedAt: NOW, updatedAt: 2_000 });
    expect(deps.changed).toHaveBeenCalledWith('ws-1');
    expect(deps.dispose).toHaveBeenCalledWith('session-1');
  });

  it('运行中、等审批的会话拒绝归档，什么都不改', async () => {
    store.put(session({ id: 'running', status: 'running' }));
    store.put(session({ id: 'waiting', status: 'waiting-approval' }));
    const { deps, archive } = make();
    for (const id of ['running', 'waiting']) {
      expect(await archive.archive(id)).toEqual({
        ok: false,
        error: '会话正在运行，结束后再归档',
      });
      expect(store.get(id)).not.toHaveProperty('archivedAt');
    }
    expect(deps.changed).not.toHaveBeenCalled();
    expect(deps.dispose).not.toHaveBeenCalled();
  });

  it('不存在的会话报错；已归档的原样返回', async () => {
    store.put(session({ archivedAt: 9_000 }));
    const { deps, archive } = make();
    expect(await archive.archive('missing')).toEqual({ ok: false, error: '会话不存在' });
    expect(await archive.archive('session-1')).toMatchObject({
      ok: true,
      session: { archivedAt: 9_000 },
    });
    expect(deps.changed).not.toHaveBeenCalled();
  });

  it('开了「归档时清理 worktree」：只对绑定了 worktree 的会话调用清理', async () => {
    store.put(session({ id: 'worker', worktreeId: 'wt_1', dispatchId: 'dispatch_1' }));
    store.put(session({ id: 'coordinator', roleId: 'orchestrator' }));
    const { deps, archive } = make();

    await archive.archive('worker');
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();

    cleanupOnArchive = true;
    store.update('worker', { archivedAt: undefined });
    await archive.archive('worker');
    await archive.archive('coordinator');
    expect(deps.cleanupWorktree.mock.calls).toEqual([
      [expect.objectContaining({ id: 'worker', worktreeId: 'wt_1', archivedAt: NOW })],
    ]);
  });

  it('清理失败不影响归档，只记日志', async () => {
    cleanupOnArchive = true;
    store.put(session({ id: 'a', worktreeId: 'wt_1' }));
    store.put(session({ id: 'b', worktreeId: 'wt_2' }));
    const { deps, archive } = make();
    deps.cleanupWorktree
      .mockResolvedValueOnce({ removed: false, reason: 'failed', error: 'EBUSY' })
      .mockRejectedValueOnce(new Error('git crashed'));
    expect(await archive.archive('a')).toMatchObject({ ok: true });
    expect(await archive.archive('b')).toMatchObject({ ok: true });
    expect(store.get('a')?.archivedAt).toBe(NOW);
    expect(store.get('b')?.archivedAt).toBe(NOW);
    expect(deps.log.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('EBUSY'),
      expect.stringContaining('git crashed'),
    ]);
  });

  it('没合并、不干净：保留 worktree，不记日志', async () => {
    cleanupOnArchive = true;
    store.put(session({ worktreeId: 'wt_1' }));
    const { deps, archive } = make();
    deps.cleanupWorktree.mockResolvedValueOnce({ removed: false, reason: 'not-merged' });
    expect(await archive.archive('session-1')).toMatchObject({ ok: true });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('让会话退出 worker 失败也照常归档', async () => {
    store.put(session());
    const { deps, archive } = make();
    deps.dispose.mockRejectedValueOnce(new Error('worker gone'));
    expect(await archive.archive('session-1')).toMatchObject({ ok: true });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('worker gone'));
  });
});

describe('unarchive', () => {
  it('清掉归档时间，闲置计时从现在重新开始，并广播', async () => {
    store.put(session({ archivedAt: 9_000 }));
    const { deps, archive } = make();
    const result = await archive.unarchive('session-1');
    expect(result).toEqual({ ok: true, session: { ...session(), updatedAt: NOW } });
    expect(store.get('session-1')).not.toHaveProperty('archivedAt');
    expect(deps.changed).toHaveBeenCalledWith('ws-1');
  });

  it('没归档的原样返回；不存在的报错', async () => {
    store.put(session());
    const { deps, archive } = make();
    expect(await archive.unarchive('session-1')).toEqual({ ok: true, session: session() });
    expect(await archive.unarchive('missing')).toEqual({ ok: false, error: '会话不存在' });
    expect(deps.changed).not.toHaveBeenCalled();
  });
});
