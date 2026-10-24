import { type GitRunner, runGit } from '../gitRepository';

/** 读一次分支的上限：git 卡住（如仓库锁）时不拖住会话列表，到点按读不到处理 */
export const BRANCH_READ_TIMEOUT_MS = 2_000;
/** 同一目录两次重读的最小间隔：会话列表每次状态变化都会重拉，不能每次都起 git */
export const BRANCH_REFRESH_THROTTLE_MS = 3_000;

/**
 * cwd 当前检出的分支：`git symbolic-ref --quiet --short HEAD`，detached 时给 `git rev-parse --short HEAD` 的短 sha；
 * 不是 git 目录、目录不存在（如已清理的 worktree）、没有 git 或超时都返回 undefined。永不 reject。
 * 超时只是不再等：进程由 runGit 自己的超时结束。
 */
export function readGitBranch(
  cwd: string,
  run: GitRunner = runGit,
  timeoutMs: number = BRANCH_READ_TIMEOUT_MS
): Promise<string | undefined> {
  return withTimeout(readBranch(cwd, run), timeoutMs);
}

async function readBranch(cwd: string, run: GitRunner): Promise<string | undefined> {
  const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();
  const sha = await run(['rev-parse', '--short', 'HEAD'], cwd);
  return sha.ok && sha.stdout.trim() ? sha.stdout.trim() : undefined;
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface BranchTracker {
  /** 缓存里 cwd 的分支；没读过或读不到时为 undefined */
  get(cwd: string): string | undefined;
  /**
   * 重读这些目录的分支，resolve 为分支有变化的目录。同一目录在节流窗口内读过的跳过（force 时不跳过），
   * 同时只起一次 git：正在读的目录等那次的结果；force 时等它读完再读一次，免得用上 checkout 之前的结果。
   */
  refresh(cwds: Iterable<string>, options?: { force?: boolean }): Promise<string[]>;
  /** 读过的目录：窗口重新获得焦点时全部重读 */
  known(): string[];
}

export interface BranchTrackerOptions {
  read: (cwd: string) => Promise<string | undefined>;
  now?: () => number;
  throttleMs?: number;
}

interface BranchEntry {
  branch: string | undefined;
  /** 最近一次读开始的时间 */
  readAt: number;
  pending?: Promise<boolean>;
}

/** 会话 cwd → 当前分支的缓存（Main 内存，不落盘） */
export function createBranchTracker({
  read,
  now = Date.now,
  throttleMs = BRANCH_REFRESH_THROTTLE_MS,
}: BranchTrackerOptions): BranchTracker {
  const entries = new Map<string, BranchEntry>();

  function refreshOne(cwd: string, force: boolean): Promise<boolean> {
    const entry = entries.get(cwd);
    if (entry?.pending) {
      return force ? entry.pending.then(() => refreshOne(cwd, true)) : entry.pending;
    }
    if (!force && entry && now() - entry.readAt < throttleMs) return Promise.resolve(false);
    const previous = entry?.branch;
    const readAt = now();
    const pending = read(cwd).then(
      (branch) => {
        entries.set(cwd, { branch, readAt });
        return branch !== previous;
      },
      () => {
        // 读失败（注入的实现可能 reject）：保留上一次的结果
        entries.set(cwd, { branch: previous, readAt });
        return false;
      }
    );
    entries.set(cwd, { branch: previous, readAt, pending });
    return pending;
  }

  return {
    get: (cwd) => entries.get(cwd)?.branch,
    async refresh(cwds, options = {}) {
      const unique = [...new Set(cwds)];
      const changed = await Promise.all(
        unique.map((cwd) => refreshOne(cwd, options.force === true))
      );
      return unique.filter((_cwd, index) => changed[index]);
    },
    known: () => [...entries.keys()],
  };
}
