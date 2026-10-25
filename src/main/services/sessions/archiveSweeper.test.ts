import type { SessionStatus } from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createArchiveSweeper,
  DAY_MS,
  planArchiveSweep,
  SWEEP_INTERVAL_MS,
  SWEEP_STARTUP_DELAY_MS,
  type SweepCandidate,
  type SweepPolicy,
} from './archiveSweeper';

const NOW = Date.UTC(2026, 9, 25, 12, 0);

function candidate(id: string, patch: Partial<SweepCandidate> = {}): SweepCandidate {
  return { id, status: 'idle', updatedAt: NOW, ...patch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('planArchiveSweep（注入时钟的纯函数）', () => {
  const off = { archiveIdleDays: 0, deleteArchivedDays: 0 } as const;

  it('闲置正好 N 天的会话归档，差 1 毫秒的不归档', () => {
    const sessions = [
      candidate('exactly', { updatedAt: NOW - 7 * DAY_MS }),
      candidate('older', { updatedAt: NOW - 40 * DAY_MS }),
      candidate('almost', { updatedAt: NOW - 7 * DAY_MS + 1 }),
      candidate('fresh'),
    ];
    expect(planArchiveSweep(sessions, { ...off, archiveIdleDays: 7 }, NOW)).toEqual({
      archive: ['exactly', 'older'],
      remove: [],
    });
    expect(planArchiveSweep(sessions, { ...off, archiveIdleDays: 30 }, NOW).archive).toEqual([
      'older',
    ]);
  });

  it('天数为 0：不归档也不删除', () => {
    const sessions = [
      candidate('idle', { updatedAt: 0 }),
      candidate('archived', { updatedAt: 0, archivedAt: 0 }),
    ];
    expect(planArchiveSweep(sessions, off, NOW)).toEqual({ archive: [], remove: [] });
  });

  it('运行中、等审批的会话不动；出错停下的照常归档；已归档的不再归档', () => {
    const long = NOW - 90 * DAY_MS;
    const statuses: SessionStatus[] = ['running', 'waiting-approval', 'error', 'idle'];
    const sessions = [
      ...statuses.map((status) => candidate(status, { status, updatedAt: long })),
      candidate('archived', { updatedAt: long, archivedAt: NOW - DAY_MS }),
    ];
    expect(planArchiveSweep(sessions, { ...off, archiveIdleDays: 7 }, NOW).archive).toEqual([
      'error',
      'idle',
    ]);
  });

  it('归档正好 N 天的删除，差 1 毫秒的保留；没归档的不删', () => {
    const sessions = [
      candidate('exactly', { archivedAt: NOW - 30 * DAY_MS }),
      candidate('almost', { archivedAt: NOW - 30 * DAY_MS + 1 }),
      candidate('older', { archivedAt: NOW - 100 * DAY_MS }),
      candidate('active', { updatedAt: NOW - 100 * DAY_MS }),
      candidate('busy', { status: 'running', archivedAt: NOW - 100 * DAY_MS }),
    ];
    expect(planArchiveSweep(sessions, { ...off, deleteArchivedDays: 30 }, NOW)).toEqual({
      archive: [],
      remove: ['exactly', 'older'],
    });
    expect(planArchiveSweep(sessions, { ...off, deleteArchivedDays: 90 }, NOW).remove).toEqual([
      'older',
    ]);
  });

  it('删除按归档时间算，不看最后更新：这一轮才归档的不会同一轮删除', () => {
    const sessions = [candidate('stale', { updatedAt: NOW - 200 * DAY_MS })];
    expect(planArchiveSweep(sessions, { archiveIdleDays: 7, deleteArchivedDays: 30 }, NOW)).toEqual(
      { archive: ['stale'], remove: [] }
    );
  });

  it('时钟往回拨（最后更新在「现在」之后）：不归档', () => {
    const sessions = [candidate('future', { updatedAt: NOW + DAY_MS })];
    expect(planArchiveSweep(sessions, { ...off, archiveIdleDays: 7 }, NOW).archive).toEqual([]);
  });
});

function sweeperWith(
  sessions: SweepCandidate[],
  preferences: SweepPolicy = { archiveIdleDays: 7, deleteArchivedDays: 30 }
) {
  const records = new Map(sessions.map((session) => [session.id, session]));
  const deps = {
    store: { all: () => [...records.values()], get: (id: string) => records.get(id) },
    archive: vi.fn(async (id: string): Promise<IpcResult> => {
      const session = records.get(id);
      if (session) records.set(id, { ...session, archivedAt: NOW });
      return { ok: true as const };
    }),
    remove: vi.fn(async (id: string): Promise<IpcResult> => {
      records.delete(id);
      return { ok: true as const };
    }),
    preferences: vi.fn(() => preferences),
    now: () => NOW,
    log: vi.fn(),
  };
  return { deps, records, sweeper: createArchiveSweeper(deps) };
}

describe('createArchiveSweeper', () => {
  it('sweep：按计划归档与删除，返回各自的数量', async () => {
    const { deps, sweeper } = sweeperWith([
      candidate('idle', { updatedAt: NOW - 8 * DAY_MS }),
      candidate('expired', { archivedAt: NOW - 31 * DAY_MS }),
      candidate('fresh'),
    ]);
    expect(await sweeper.sweep()).toEqual({ archived: 1, removed: 1 });
    expect(deps.archive.mock.calls).toEqual([['idle']]);
    expect(deps.remove.mock.calls).toEqual([['expired']]);
  });

  it('动手前按最新记录再判一次：计划之后开始运行或已被删除的会话跳过', async () => {
    const { deps, records, sweeper } = sweeperWith([
      candidate('a', { updatedAt: NOW - 8 * DAY_MS }),
      candidate('b', { updatedAt: NOW - 8 * DAY_MS }),
      candidate('c', { updatedAt: NOW - 8 * DAY_MS }),
    ]);
    deps.archive.mockImplementationOnce(async (id) => {
      // 归档 a 的过程中：b 开始运行，c 被删除
      const b = records.get('b');
      if (b) records.set('b', { ...b, status: 'running', updatedAt: NOW });
      records.delete('c');
      records.set(id, { ...candidate(id), archivedAt: NOW });
      return { ok: true };
    });
    expect(await sweeper.sweep()).toEqual({ archived: 1, removed: 0 });
    expect(deps.archive.mock.calls).toEqual([['a']]);
  });

  it('单个会话失败只记日志，不影响其他会话', async () => {
    const { deps, sweeper } = sweeperWith([
      candidate('a', { updatedAt: NOW - 8 * DAY_MS }),
      candidate('b', { updatedAt: NOW - 8 * DAY_MS }),
    ]);
    deps.archive.mockResolvedValueOnce({ ok: false, error: '会话正在运行' });
    expect(await sweeper.sweep()).toEqual({ archived: 1, removed: 0 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('会话正在运行'));
  });

  it('每次扫描现读设置：关掉之后不再归档', async () => {
    const { deps, sweeper } = sweeperWith([candidate('a', { updatedAt: NOW - 8 * DAY_MS })]);
    deps.preferences.mockReturnValue({ archiveIdleDays: 0, deleteArchivedDays: 0 });
    expect(await sweeper.sweep()).toEqual({ archived: 0, removed: 0 });
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it('同时发起的扫描排队执行，不会同时改同一批会话', async () => {
    const { deps, sweeper } = sweeperWith([candidate('a', { updatedAt: NOW - 8 * DAY_MS })]);
    const [first, second] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(first).toEqual({ archived: 1, removed: 0 });
    // 第二次在第一次之后才开始：a 已归档
    expect(second).toEqual({ archived: 0, removed: 0 });
    expect(deps.archive).toHaveBeenCalledTimes(1);
  });

  it('定时：启动后 30 秒扫第一次，之后每小时一次；stop 之后不再扫', async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = sweeperWith([]);
    sweeper.start();
    sweeper.start(); // 重复 start 不会多排一份
    await vi.advanceTimersByTimeAsync(SWEEP_STARTUP_DELAY_MS - 1);
    expect(deps.preferences).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.preferences).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
    expect(deps.preferences).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.preferences).toHaveBeenCalledTimes(2);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(3 * SWEEP_INTERVAL_MS);
    expect(deps.preferences).toHaveBeenCalledTimes(2);
    expect(SWEEP_STARTUP_DELAY_MS).toBe(30_000);
    expect(SWEEP_INTERVAL_MS).toBe(3_600_000);
  });

  it('某次扫描抛异常：记日志，下一小时照常扫', async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = sweeperWith([]);
    deps.preferences.mockImplementationOnce(() => {
      throw new Error('settings.json 读不了');
    });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(SWEEP_STARTUP_DELAY_MS);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('settings.json 读不了'));
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(deps.preferences).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });
});
