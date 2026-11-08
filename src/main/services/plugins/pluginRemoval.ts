import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isStrictlyInside } from './pluginCopies';

/** 待清理列表上限（plugins.json 顶层 pendingDeletes） */
export const MAX_PENDING_DELETES = 50;

/**
 * Fynvra 可以删除插件目录的受管根目录：副本根目录（新装的 npm / git 与本地副本都在这里），以及旧版经 pi 安装的
 * `userData/agent/git`、`userData/agent/npm/node_modules`。
 */
export interface ManagedRoots {
  copyRoot: string;
  legacyGit: string;
  legacyNpm: string;
}

export function managedRoots(copyRoot: string, agentDir: string): ManagedRoots {
  return {
    copyRoot,
    legacyGit: join(agentDir, 'git'),
    legacyNpm: join(agentDir, 'npm', 'node_modules'),
  };
}

/** root 之下的相对路径段；不严格位于 root 内时为 null（path.win32.relative 本身不分大小写） */
function segmentsUnder(root: string, path: string): string[] | null {
  if (!isStrictlyInside(root, path)) return null;
  return relative(resolve(root), resolve(path)).split(sep).filter(Boolean);
}

/**
 * 校验「属于某个插件自己的目录」，合法时返回 resolve 后的路径，否则 null：
 * - 副本根目录下恰好一层（`<root>/<dir>`，含残留的 `.tmp-` / `.old-`）；
 * - 旧 git：`agent/git/<host>/<路径…>`，至少两层；
 * - 旧 npm：`agent/npm/node_modules/<包>` 或 `…/@scope/<包>`。
 * 永远不会是受管根目录本身或其上级。
 */
export function ownedPluginDir(roots: ManagedRoots, path: string): string | null {
  const copy = segmentsUnder(roots.copyRoot, path);
  if (copy) return copy.length === 1 ? resolve(path) : null;
  const git = segmentsUnder(roots.legacyGit, path);
  if (git) return git.length >= 2 ? resolve(path) : null;
  const npm = segmentsUnder(roots.legacyNpm, path);
  if (npm) {
    const depth = npm[0]?.startsWith('@') ? 2 : 1;
    return npm.length === depth ? resolve(path) : null;
  }
  return null;
}

/**
 * 旧版 npm / git 条目（登记路径在 agent 目录下）自己的目录；不在旧受管目录内时 null。
 * git 登记的就是仓库目录；npm 登记的是 `node_modules/<包>`。
 */
export function legacyPluginDir(
  roots: ManagedRoots,
  kind: 'npm' | 'git',
  path: string
): string | null {
  const segments = segmentsUnder(kind === 'git' ? roots.legacyGit : roots.legacyNpm, path);
  if (!segments) return null;
  return ownedPluginDir(roots, path);
}

/** 只带错误码的 Error，不带 fs 错误里的路径 */
function codeError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const wrapped = new Error(typeof code === 'string' ? code : 'unknown');
  if (typeof code === 'string') (wrapped as NodeJS.ErrnoException).code = code;
  return wrapped;
}

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/**
 * 稳健删除受管插件目录：先校验 `dir` 是插件自己的目录（见 {@link ownedPluginDir}），再 rm（带重试）；
 * Windows 上遇到 EPERM / EACCES（如 git 的只读 pack 文件）先把整棵树改成可写再试一次。
 * 失败时抛出只带错误码的 Error。目录不存在视为成功。
 */
export async function removeManagedDir(roots: ManagedRoots, dir: string): Promise<void> {
  const target = ownedPluginDir(roots, dir);
  if (!target) throw new Error('outside-managed-root');
  try {
    await rm(target, RM_OPTIONS);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) {
      throw codeError(error);
    }
  }
  await makeWritable(target);
  try {
    await rm(target, RM_OPTIONS);
  } catch (error) {
    throw codeError(error);
  }
}

/** 去掉只读属性：文件 0o666、目录 0o777；不跟随符号链接 / junction */
async function makeWritable(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  const isDir = info.isDirectory();
  await chmod(path, isDir ? 0o777 : 0o666).catch(() => undefined);
  if (!isDir) return;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) await makeWritable(join(path, entry));
}
