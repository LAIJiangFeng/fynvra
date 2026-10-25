import { errorMessage } from '@shared/guards';
import type { SessionStatus, SessionSummary } from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import type { SessionPreferences } from '@shared/types/settings';

export const DAY_MS = 86_400_000;
/** 启动后多久扫第一次：避开启动时的会话恢复与编排快照加载 */
export const SWEEP_STARTUP_DELAY_MS = 30_000;
/** 之后每隔多久扫一次 */
export const SWEEP_INTERVAL_MS = 3_600_000;

export type SweepCandidate = Pick<SessionSummary, 'id' | 'status' | 'updatedAt' | 'archivedAt'>;
export type SweepPolicy = Pick<SessionPreferences, 'archiveIdleDays' | 'deleteArchivedDays'>;

export interface SweepPlan {
  /** 闲置够久、该归档的会话 */
  archive: string[];
  /** 归档够久、该删除记录的会话 */
  remove: string[];
}

/** 正在跑一轮或等审批：归档、删除都不碰 */
export function isBusyStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting-approval';
}

/** 没归档、没在跑，最后更新距今达到 archiveIdleDays 天（正好 N 天也算）；0 天为关闭 */
export function shouldArchive(session: SweepCandidate, idleDays: number, now: number): boolean {
  return (
    idleDays > 0 &&
    session.archivedAt === undefined &&
    !isBusyStatus(session.status) &&
    now - session.updatedAt >= idleDays * DAY_MS
  );
}

/** 已归档、没在跑，归档距今达到 deleteArchivedDays 天；0 天为永不 */
export function shouldRemove(session: SweepCandidate, days: number, now: number): boolean {
  return (
    days > 0 &&
    session.archivedAt !== undefined &&
    !isBusyStatus(session.status) &&
    now - session.archivedAt >= days * DAY_MS
  );
}

/**
 * 按设置与当前时间决定哪些会话归档、哪些删除记录（纯函数，时钟由调用方传入）。
 * 删除按归档时间算：这一轮才归档的会话不会在同一轮被删除。
 */
export function planArchiveSweep(
  sessions: readonly SweepCandidate[],
  policy: SweepPolicy,
  now: number
): SweepPlan {
  return {
    archive: sessions
      .filter((session) => shouldArchive(session, policy.archiveIdleDays, now))
      .map((session) => session.id),
    remove: sessions
      .filter((session) => shouldRemove(session, policy.deleteArchivedDays, now))
      .map((session) => session.id),
  };
}

export interface ArchiveSweeperDeps {
  store: { all(): readonly SweepCandidate[]; get(id: string): SweepCandidate | undefined };
  /** 归档一个会话（同 sessions:archive，含按设置清理 worktree） */
  archive(sessionId: string): Promise<IpcResult>;
  /** 删除会话记录（同 sessions:remove：pi jsonl 保留） */
  remove(sessionId: string): Promise<IpcResult>;
  /** 「通用 → 会话」的设置，每次扫描现读 */
  preferences(): SweepPolicy;
  now?(): number;
  log?(message: string): void;
  startupDelayMs?: number;
  intervalMs?: number;
}

export interface ArchiveSweepResult {
  archived: number;
  removed: number;
}

export interface ArchiveSweeper {
  /** 立即扫一次；与正在进行的扫描排队，不会同时改同一批会话 */
  sweep(): Promise<ArchiveSweepResult>;
  /** 启动后 {@link SWEEP_STARTUP_DELAY_MS} 扫第一次，之后每 {@link SWEEP_INTERVAL_MS} 一次；重复调用无效 */
  start(): void;
  stop(): void;
}

/** 闲置归档与过期删除的定时扫描（Main 的会话注册表是权威，扫描结果经各自的 sessions:changed 广播） */
export function createArchiveSweeper(deps: ArchiveSweeperDeps): ArchiveSweeper {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[sessions] ${message}`));
  const startupDelayMs = deps.startupDelayMs ?? SWEEP_STARTUP_DELAY_MS;
  const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  async function act(
    ids: readonly string[],
    stillDue: (session: SweepCandidate) => boolean,
    run: (sessionId: string) => Promise<IpcResult>,
    verb: string
  ): Promise<number> {
    let done = 0;
    for (const id of ids) {
      // 计划之后会话可能开始运行或已被删除：动手前按最新记录再判一次
      const current = deps.store.get(id);
      if (!current || !stillDue(current)) continue;
      const result = await run(id);
      if (result.ok) done += 1;
      else log(`${verb}会话 ${id} 失败：${result.error}`);
    }
    return done;
  }

  async function runSweep(): Promise<ArchiveSweepResult> {
    const policy = deps.preferences();
    const plan = planArchiveSweep(deps.store.all(), policy, now());
    const archived = await act(
      plan.archive,
      (session) => shouldArchive(session, policy.archiveIdleDays, now()),
      deps.archive,
      '归档'
    );
    const removed = await act(
      plan.remove,
      (session) => shouldRemove(session, policy.deleteArchivedDays, now()),
      deps.remove,
      '删除'
    );
    return { archived, removed };
  }

  function sweep(): Promise<ArchiveSweepResult> {
    const run = queue.then(runSweep);
    queue = run.catch(() => undefined);
    return run;
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      void sweep()
        .catch((error: unknown) => log(`扫描闲置会话失败：${errorMessage(error)}`))
        .finally(() => {
          if (started) schedule(intervalMs);
        });
    }, delayMs);
  }

  return {
    sweep,
    start() {
      if (started) return;
      started = true;
      schedule(startupDelayMs);
    },
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
