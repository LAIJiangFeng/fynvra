import { randomUUID } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import type { Workspace, Worktree } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type {
  WorkspaceWorktreesInfo,
  WorktreesRootInfo,
  WorktreesUsage,
} from '@shared/types/settings';

// worktree 放在哪。这里算出的是 GitWorktreeManager.create 的 `worktreesRoot`，worktree 本身在它下面的
// `<workspaceId>/<slug>`：
// - 配置了 preferences.worktreesRoot：`<worktreesRoot>/<仓库目录名>`；
// - 默认：仓库同级的 `<仓库目录名>-worktrees`，与仓库同盘（D:\project\fynvra → D:\project\fynvra-worktrees）；
// - 默认位置用不了（父目录不可写、仓库在根目录上、落在另一个已挂入的仓库里）：`userData/worktrees`。

export const WORKTREES_DIR_SUFFIX = '-worktrees';

/** 默认位置用不了时的退回目录。 */
export function fallbackWorktreesRoot(userDataPath: string): string {
  return join(userDataPath, 'worktrees');
}

/** 仓库同级的 `<仓库目录名>-worktrees`；仓库就在盘符 / 文件系统根上时没有同级目录，返回 undefined。 */
export function defaultWorktreesRoot(repoPath: string): string | undefined {
  const repo = resolve(repoPath);
  const name = basename(repo);
  return name === '' || dirname(repo) === repo
    ? undefined
    : join(dirname(repo), `${name}${WORKTREES_DIR_SUFFIX}`);
}

/** 用户配置的根目录下按仓库目录名分组：`<worktreesRoot>/<仓库目录名>`。 */
export function configuredWorktreesRoot(worktreesRoot: string, repoPath: string): string {
  return join(resolve(worktreesRoot), basename(resolve(repoPath)));
}

/** `child` 就是 `parent` 或在它里面；Windows 不区分大小写。 */
export function isInsideDirectory(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export interface WorktreesRootPlan {
  root: string;
  /** 默认位置用不了、退回 fallbackRoot 的原因（设置页展示） */
  fallback?: string;
}

/**
 * 不碰磁盘的推导，设置页展示与 {@link createWorktreesRootResolver} 共用。
 * `configured` 须是绝对路径；`repoPaths` 是全部已挂入仓库，默认位置不能落进其中任何一个。
 */
export function planWorktreesRoot(input: {
  repoPath: string;
  configured?: string;
  fallbackRoot: string;
  repoPaths: readonly string[];
}): WorktreesRootPlan {
  const { repoPath, configured, fallbackRoot } = input;
  if (configured !== undefined) return { root: configuredWorktreesRoot(configured, repoPath) };
  const root = defaultWorktreesRoot(repoPath);
  if (root === undefined) {
    return { root: fallbackRoot, fallback: `仓库 ${repoPath} 在磁盘根目录上，没有同级目录` };
  }
  const host = input.repoPaths.find((repo) => isInsideDirectory(root, repo));
  if (host !== undefined) {
    return { root: fallbackRoot, fallback: `同级目录 ${root} 在已挂入的仓库 ${host} 里` };
  }
  return { root };
}

/** 配置值规整成绝对路径；不是绝对路径（手改 settings.json）时视为未配置。 */
function usableRoot(
  value: string | undefined,
  log?: (message: string) => void
): string | undefined {
  if (value === undefined) return undefined;
  if (isAbsolute(value)) return resolve(value);
  log?.(`preferences.worktreesRoot "${value}" is not an absolute path; using the default location`);
  return undefined;
}

/** resolver 与校验用到的 `node:fs/promises` 子集，测试可替换。 */
export interface ProbeFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

/** 目录能否放 worktree：递归建出来，写一个探测文件再删掉（Windows 上 access(W_OK) 不看 ACL）。 */
export async function probeWritable(
  dir: string,
  fs: ProbeFs = nodeFs
): Promise<{ ok: true } | { ok: false; error: string }> {
  const probe = join(dir, `.fynvra-probe-${randomUUID()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, '');
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  await fs.rm(probe, { force: true }).catch(() => undefined);
  return { ok: true };
}

/** 工作区的 worktree 根目录；registry → service → host 每次建 worktree 时调用。从不 reject。 */
export type ResolveWorktreesRoot = (workspace: Workspace) => Promise<string>;

export interface WorktreesRootResolverOptions {
  /** {@link fallbackWorktreesRoot} */
  fallbackRoot: string;
  /** `preferences.worktreesRoot`，每次调用现读 */
  configured: () => string | undefined;
  /** 已挂入仓库的路径 */
  repoPaths: () => readonly string[];
  fs?: ProbeFs;
  log?: (message: string) => void;
}

/**
 * 每次调用按当前设置推导：配置了根目录就直接用（在 settings:pick-worktrees-root 校验过，现在用不了就让 git 报错，
 * 不悄悄换地方）；默认位置先建出目录并确认可写，不行就退回 fallbackRoot 并记 warning。
 */
export function createWorktreesRootResolver(
  options: WorktreesRootResolverOptions
): ResolveWorktreesRoot {
  const fs = options.fs ?? nodeFs;
  const log = options.log ?? ((message: string) => console.warn(`[orchestration] ${message}`));
  return async (workspace) => {
    const configured = usableRoot(options.configured(), log);
    const plan = planWorktreesRoot({
      repoPath: workspace.repoPath,
      configured,
      fallbackRoot: options.fallbackRoot,
      repoPaths: options.repoPaths(),
    });
    if (configured !== undefined) return plan.root;
    let reason = plan.fallback;
    if (reason === undefined) {
      const probe = await probeWritable(plan.root, fs);
      if (probe.ok) return plan.root;
      reason = `cannot write to ${plan.root}: ${probe.error}`;
    }
    log(`worktrees of ${workspace.repoPath} go to ${options.fallbackRoot}: ${reason}`);
    return options.fallbackRoot;
  };
}

export interface ValidateFs extends ProbeFs {
  realpath(path: string): Promise<string>;
}

function repoConflict(root: string, repoPaths: readonly string[]): string | undefined {
  for (const repo of repoPaths) {
    if (isInsideDirectory(root, repo)) {
      return `${root} 是已挂入的仓库 ${repo} 或在它里面，worktree 不能建在仓库内`;
    }
    const target = configuredWorktreesRoot(root, repo);
    if (isInsideDirectory(target, repo)) {
      return `仓库 ${repo} 的 worktree 会落在 ${target}，也就是仓库里面；请选一个专门放 worktree 的目录`;
    }
  }
  return undefined;
}

/**
 * `settings:pick-worktrees-root` 的校验：绝对路径；不是已挂入的仓库、也不在仓库里面（已存在的目录再按真实路径查一次，
 * junction / 符号链接指进仓库也算）；各仓库的 `<根目录>/<仓库目录名>` 不能落进仓库（例如选了仓库的父目录）；
 * 能创建、能写（会建出这个目录）。通过时返回规整后的路径。
 */
export async function validateWorktreesRoot(
  candidate: string,
  options: { repoPaths: readonly string[]; fs?: ValidateFs }
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const fs = options.fs ?? nodeFs;
  if (!isAbsolute(candidate)) return { ok: false, error: `不是绝对路径：${candidate}` };
  const root = resolve(candidate);
  const real = await fs.realpath(root).catch(() => root);
  for (const path of new Set([root, real])) {
    const conflict = repoConflict(path, options.repoPaths);
    if (conflict !== undefined) return { ok: false, error: conflict };
  }
  const probe = await probeWritable(root, fs);
  if (!probe.ok) return { ok: false, error: `无法在 ${root} 下创建文件：${probe.error}` };
  return { ok: true, path: root };
}

/** 占用统计用到的 `node:fs/promises` 子集。 */
export interface SizeFs {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
}

export interface MeasureOptions {
  signal?: AbortSignal;
  fs?: SizeFs;
}

export interface DirectorySize {
  bytes: number;
  files: number;
}

/** 每轮并发读的目录数 / lstat 的文件数：够快，又不会一下子塞满 libuv 线程池的队列 */
const DIRS_PER_ROUND = 16;
const STATS_PER_ROUND = 64;

/**
 * 递归统计目录里文件的总大小。不跟随符号链接与 junction（pnpm 的 node_modules 里很多）；硬链接按 (dev, ino)
 * 只计一次，`seen` 可在多次调用间共享；读不了的子目录、文件跳过。根目录不存在（或读不了）时返回 undefined。
 * 每轮之间检查 `signal`，中止时以 AbortError reject。
 */
export async function measureDirectory(
  root: string,
  options: MeasureOptions & { seen?: Set<string> } = {}
): Promise<DirectorySize | undefined> {
  const fs = options.fs ?? nodeFs;
  const seen = options.seen ?? new Set<string>();
  const { signal } = options;
  signal?.throwIfAborted();
  let listings: { dir: string; entries: Dirent[] }[];
  try {
    listings = [{ dir: root, entries: await fs.readdir(root, { withFileTypes: true }) }];
  } catch {
    return undefined;
  }
  const size: DirectorySize = { bytes: 0, files: 0 };
  const pending: string[] = [];
  while (listings.length > 0) {
    const files: string[] = [];
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(join(dir, entry.name));
        else if (entry.isFile()) files.push(join(dir, entry.name));
      }
    }
    for (let start = 0; start < files.length; start += STATS_PER_ROUND) {
      signal?.throwIfAborted();
      const batch = files.slice(start, start + STATS_PER_ROUND);
      const stats = await Promise.all(
        batch.map((file) => fs.lstat(file, { bigint: true }).catch(() => undefined))
      );
      for (const stat of stats) {
        if (stat === undefined) continue;
        if (stat.nlink > 1n) {
          const key = `${stat.dev}:${stat.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        size.bytes += Number(stat.size);
        size.files += 1;
      }
    }
    signal?.throwIfAborted();
    listings = await Promise.all(
      pending.splice(-DIRS_PER_ROUND).map(async (dir) => ({
        dir,
        entries: await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []),
      }))
    );
  }
  return size;
}

/** 一组 worktree 的总占用：组内共享的硬链接只计一次，目录已不存在的计入 missing。 */
export async function measureWorktrees(
  worktrees: readonly Pick<Worktree, 'path'>[],
  options: MeasureOptions = {}
): Promise<WorktreesUsage> {
  const seen = new Set<string>();
  const usage: WorktreesUsage = { bytes: 0, missing: 0 };
  for (const worktree of worktrees) {
    const size = await measureDirectory(worktree.path, { ...options, seen });
    if (size === undefined) usage.missing += 1;
    else usage.bytes += size.bytes;
  }
  return usage;
}

export interface WorktreesRootInfoInput extends MeasureOptions {
  /** `preferences.worktreesRoot` */
  configured: string | undefined;
  fallbackRoot: string;
  workspaces: readonly Workspace[];
  /** 该工作区编排快照里登记的 worktree */
  worktreesOf: (workspaceId: string) => Promise<readonly Pick<Worktree, 'path'>[]>;
  /** 是否统计目录大小（慢）；false 时只推导路径 */
  usage: boolean;
}

/** 设置页「通用」的数据：生效的根目录，各工作区的去向、登记数与占用。只读，不会建出默认目录。 */
export async function collectWorktreesRootInfo(
  input: WorktreesRootInfoInput
): Promise<WorktreesRootInfo> {
  const configured = usableRoot(input.configured);
  const repoPaths = input.workspaces.map((workspace) => workspace.repoPath);
  const workspaces: WorkspaceWorktreesInfo[] = [];
  for (const workspace of input.workspaces) {
    const plan = planWorktreesRoot({
      repoPath: workspace.repoPath,
      configured,
      fallbackRoot: input.fallbackRoot,
      repoPaths,
    });
    const worktrees = await input.worktreesOf(workspace.id);
    workspaces.push({
      workspaceId: workspace.id,
      name: workspace.name,
      root: plan.root,
      ...(plan.fallback === undefined ? {} : { fallback: plan.fallback }),
      count: worktrees.length,
      ...(input.usage ? { usage: await measureWorktrees(worktrees, input) } : {}),
    });
  }
  return {
    isDefault: configured === undefined,
    ...(configured === undefined ? {} : { worktreesRoot: configured }),
    fallbackRoot: input.fallbackRoot,
    workspaces,
  };
}
