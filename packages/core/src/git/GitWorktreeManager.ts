import { errorMessage, joinPath } from '../internal/files';
import { newId } from '../orchestration/ids';
import type { Worktree } from '../types';

/** 一次命令执行的结果。 */
export interface ExecResult {
  /** 退出码；非零照常 resolve。 */
  code: number;
  /** 标准输出（UTF-8 原文，不 trim）。 */
  stdout: string;
  /** 标准错误（UTF-8 原文，不 trim）。 */
  stderr: string;
}

/**
 * 注入的命令执行：以 `cwd` 为工作目录运行 `cmd args…`（不经 shell）。非零退出码用 `code` 表达，
 * 只有进程起不来（如 git 不存在、`cwd` 不存在）时才 reject。Main 侧用 `execFile` 实现即可：
 *
 * ```ts
 * const exec: ExecFn = (cmd, args, cwd) =>
 *   new Promise((resolve, reject) =>
 *     execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
 *       error && typeof error.code !== 'number'
 *         ? reject(error)
 *         : resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
 *     )
 *   );
 * ```
 */
export type ExecFn = (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

/** {@link GitWorktreeManager} 构造参数。 */
export interface GitWorktreeManagerOptions {
  /** 执行 git 的函数；所有 git 调用都经过它。 */
  exec: ExecFn;
  /**
   * 递归删除目录（Main 侧用 `fs.rm(path, { recursive: true, force: true, maxRetries: 3 })`）。
   * 仅作 `git worktree remove` 失败（如 Windows 上 "Filename too long"）后的兜底；不传则没有兜底。
   */
  removeDir?: (path: string) => Promise<void>;
  /**
   * 路径是什么（Main 侧用 `fs.lstat`，不跟随链接；ENOENT → `'missing'`，其它错误照常 reject）。
   * 仅用于兜底删除 git 已注销的残留目录（见 {@link RemoveWorktreeInput.ownedRoot}）；不传则不处理残留目录。
   */
  pathKind?: (path: string) => Promise<PathKind>;
}

/** {@link GitWorktreeManagerOptions.pathKind} 的结果。 */
export type PathKind = 'missing' | 'directory' | 'file' | 'other';

/** {@link GitWorktreeManager.remove} 入参。 */
export interface RemoveWorktreeInput {
  /** 主仓库路径。 */
  repoPath: string;
  /** 要删的 worktree 目录。 */
  path: string;
  /** 有未提交改动也删（`git worktree remove --force`）。 */
  force?: boolean;
  /**
   * 调用方担保的 worktree 托管根目录（{@link CreateWorktreeInput.worktreesRoot}）。仅 `force` 时生效：
   * git 已不再登记该路径（之前的删除做了一半）时，只要 `path` 严格位于它之内、不是也不包含主仓库、
   * 顶层没有 `.git` 目录（嵌套的真仓库），就删掉该残留目录。
   */
  ownedRoot?: string;
}

/**
 * 每条 git 命令都带上的配置：Git for Windows 默认 `core.longpaths=false`，超过 MAX_PATH 的路径
 * （如 worktree 里 pnpm 装的 node_modules）无法删除/检出；其它平台上无影响。
 */
export const GIT_CONFIG_ARGS: readonly string[] = ['-c', 'core.longpaths=true'];

/** {@link GitWorktreeManager.create} 入参。 */
export interface CreateWorktreeInput {
  /** 主仓库路径。 */
  repoPath: string;
  /** 工作区 id，作为 worktree 目录的一段（只允许字母、数字、`_`、`-`）。 */
  workspaceId: string;
  /** 任意文本，经 {@link normalizeSlug} 规整后用作分支名与目录名。 */
  slug: string;
  /** 从哪个引用切出（如 `main`、`HEAD`）。 */
  baseRef: string;
  /** worktree 托管根目录，如 `userData/worktrees`。 */
  worktreesRoot: string;
}

/** worktree 相对基准的状态。 */
export interface WorktreeStatus {
  /** 有未提交改动或未跟踪文件。 */
  dirty: boolean;
  /** HEAD 有、基准没有的提交数。 */
  ahead: number;
  /** 基准有、HEAD 没有的提交数（基准在 worktree 创建后又前进了）。 */
  behind: number;
}

/** 不带额外数据的 git 操作结果。 */
export type GitResult = { ok: true } | { ok: false; error: string };
/** {@link GitWorktreeManager.create} 的结果。 */
export type CreateWorktreeResult = { ok: true; worktree: Worktree } | { ok: false; error: string };
/** {@link GitWorktreeManager.status} 的结果。 */
export type WorktreeStatusResult =
  | { ok: true; status: WorktreeStatus }
  | { ok: false; error: string };
/** {@link GitWorktreeManager.diff} 的结果：改动文件列表 + 统一格式补丁。 */
export type WorktreeDiffResult =
  | { ok: true; files: string[]; patch: string }
  | { ok: false; error: string };
/** {@link GitWorktreeManager.merge} 的结果；冲突时 `conflicts` 列出冲突文件（合并已中止）。 */
export type MergeResult =
  | { ok: true; commit: string }
  | { ok: false; error: string; conflicts?: string[] };

/** fynvra 分支前缀。 */
export const BRANCH_PREFIX = 'fynvra/';
/** slug（含冲突后缀）最大长度。 */
export const MAX_SLUG_LENGTH = 40;
const MAX_ATTEMPTS = 99;
const WORKSPACE_ID = /^[\w-]+$/;

/**
 * 把任意文本规整为 slug：去变音符号、小写、非 `[a-z0-9]` 连续段换成单个 `-`、去首尾 `-`、
 * 截断到 {@link MAX_SLUG_LENGTH}；结果为空（如纯中文）时为 `'task'`。
 */
export function normalizeSlug(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/** 第 n 个候选：n = 1 原样，之后追加 `-n` 并保证总长不超过上限。 */
function slugCandidate(slug: string, attempt: number): string {
  if (attempt === 1) return slug;
  const suffix = `-${attempt}`;
  return `${slug.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** 作为 git 参数安全的引用：非空、不以 `-` 开头（防参数注入）、不含空白与控制字符。 */
function isSafeRefArg(ref: string): boolean {
  return (
    typeof ref === 'string' &&
    ref !== '' &&
    !ref.startsWith('-') &&
    [...ref].every((char) => char.charCodeAt(0) > 0x20 && char.charCodeAt(0) !== 0x7f)
  );
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** 比较用的路径形式：统一 `/`、去重复与末尾分隔符；带盘符的（Windows）不区分大小写。 */
function comparablePath(path: string): string {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 绝对路径且至少两段（排除空串、`/`、`C:\`、`/a` 这类根或近根路径）。 */
function isDeletablePath(path: string): boolean {
  const normalized = comparablePath(path);
  const absolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized);
  const segments = normalized.split('/').filter((part) => part !== '' && !/^[a-z]:$/i.test(part));
  return absolute && segments.length >= 2 && !segments.includes('..') && !segments.includes('.');
}

/** 绝对路径、无 `.` / `..` 段，且 `path` 严格位于 `root` 之内。 */
function isStrictlyInside(path: string, root: string): boolean {
  const target = comparablePath(path);
  const base = comparablePath(root);
  const segments = base.split('/');
  const absolute = base.startsWith('/') || /^[a-z]:\//i.test(base);
  return (
    absolute &&
    !segments.includes('..') &&
    !segments.includes('.') &&
    isDeletablePath(path) &&
    target.startsWith(`${base}/`)
  );
}

/** `git worktree list --porcelain` 的各 worktree 路径；第一个是主 worktree。 */
function parseWorktreeList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function describeFailure(args: readonly string[], result: ExecResult): string {
  const subcommand = args[0] === '-c' ? args[2] : args[0];
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return `git ${subcommand} failed: ${detail}`;
}

/**
 * fynvra 托管的 git worktree 操作。所有 git 调用都经注入的 {@link ExecFn}，方法从不抛异常，
 * 失败以 `{ ok: false, error }` 返回；不解析 git 的提示文本（避免受本地化影响），只看退出码和机器可读输出。
 */
export class GitWorktreeManager {
  readonly #exec: ExecFn;
  readonly #removeDir: ((path: string) => Promise<void>) | undefined;
  readonly #pathKind: ((path: string) => Promise<PathKind>) | undefined;
  #pendingCreate: Promise<unknown> = Promise.resolve();

  /** @param options - 注入的 {@link ExecFn} 与可选的 `removeDir`。 */
  constructor(options: GitWorktreeManagerOptions) {
    this.#exec = options.exec;
    this.#removeDir = options.removeDir;
    this.#pathKind = options.pathKind;
  }

  /**
   * 从 `baseRef` 切出新分支 `fynvra/<slug>` 并检出到 `<worktreesRoot>/<workspaceId>/<slug>`。
   * 分支已存在时依次尝试 `<slug>-2`、`<slug>-3`…；同一实例上的并发调用按顺序执行，不会抢到同一个名字。
   * `worktree add` 失败（如目标目录已存在且非空）时，删掉 git 已建出的分支再返回错误。
   */
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    // 意外异常也转成失败结果：排队链上不能留下 rejected promise，否则后续调用全部跟着失败
    const result = this.#pendingCreate
      .then(() => this.#create(input))
      .catch((error: unknown) => fail(`worktree create failed: ${errorMessage(error)}`));
    this.#pendingCreate = result;
    return result;
  }

  /** dirty / ahead / behind；基准取 `baseRef` 的当前位置，解析不到时退回 `baseCommit`。 */
  async status(
    worktree: Pick<Worktree, 'path' | 'baseRef' | 'baseCommit'>
  ): Promise<WorktreeStatusResult> {
    const porcelain = await this.#git(['status', '--porcelain'], worktree.path);
    if (porcelain.code !== 0) return fail(describeFailure(['status'], porcelain));

    let base = worktree.baseCommit;
    if (isSafeRefArg(worktree.baseRef)) {
      const ref = await this.#git(
        ['rev-parse', '--verify', '--quiet', `${worktree.baseRef}^{commit}`],
        worktree.path
      );
      if (ref.code === 0 && ref.stdout.trim() !== '') base = ref.stdout.trim();
    }
    if (!isSafeRefArg(base)) return fail(`invalid baseCommit: ${JSON.stringify(base)}`);

    const args = ['rev-list', '--left-right', '--count', `${base}...HEAD`];
    const counts = await this.#git(args, worktree.path);
    if (counts.code !== 0) return fail(describeFailure(args, counts));
    // 输出是「基准侧<TAB>HEAD 侧」
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    if (
      behind === undefined ||
      ahead === undefined ||
      !Number.isInteger(behind) ||
      !Number.isInteger(ahead)
    ) {
      return fail(`unexpected git rev-list output: ${JSON.stringify(counts.stdout)}`);
    }
    return { ok: true, status: { dirty: porcelain.stdout.trim() !== '', ahead, behind } };
  }

  /**
   * `baseCommit...headRef` 的已提交改动，不含未提交改动。
   * @param baseCommit - 默认 `worktree.baseCommit`；传目标分支名可只看相对它当前位置的改动。
   * @param headRef - 默认 HEAD；指定 worker 分支或提交时可在主仓库读取，不依赖 worktree 目录。
   */
  async diff(
    worktree: Pick<Worktree, 'path' | 'baseCommit'>,
    baseCommit: string = worktree.baseCommit,
    headRef = 'HEAD'
  ): Promise<WorktreeDiffResult> {
    if (!isSafeRefArg(baseCommit)) return fail(`invalid baseCommit: ${JSON.stringify(baseCommit)}`);
    if (!isSafeRefArg(headRef)) return fail(`invalid headRef: ${JSON.stringify(headRef)}`);
    const range = `${baseCommit}...${headRef}`;
    const namesArgs = ['diff', '--name-only', '-z', range];
    const names = await this.#git(namesArgs, worktree.path);
    if (names.code !== 0) return fail(describeFailure(namesArgs, names));
    const patchArgs = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', range];
    const patch = await this.#git(patchArgs, worktree.path);
    if (patch.code !== 0) return fail(describeFailure(patchArgs, patch));
    return { ok: true, files: splitNul(names.stdout), patch: patch.stdout };
  }

  /**
   * `git worktree remove`；有未提交改动或未跟踪文件时 git 会拒绝，除非 `force`。
   * 目录已被手动删掉时同样会注销该 worktree。分支保留（见 {@link GitWorktreeManager.deleteBranch}）。
   *
   * git 删除失败（如 Windows 上 "Filename too long"）且注入了 `removeDir` 时兜底，删目录后
   * `git worktree prune`，登记随之消失才算成功：
   * - `path` 仍是登记的（非主）worktree：`force` 或 `git status` 确认它干净才删；非 force 下的「有改动」拒绝不会被绕过。
   * - 删除前登记、删除后不再登记：git 已过了自己的干净检查、删掉了 `.git` 链接与管理目录，只是没删完目录，直接删。
   * - 删除前就未登记（之前那次删除留下的残留）：仅 `force` 且给了 `ownedRoot` 时按其约束删除（需注入 `pathKind`）。
   * 此时目录根本不存在则只 prune，返回成功（删除是幂等的）。
   */
  async remove(input: RemoveWorktreeInput): Promise<GitResult> {
    // 先记下登记列表：git 删到一半失败时已经注销了该 worktree，事后就查不到了
    const before =
      this.#removeDir === undefined ? undefined : await this.#listWorktrees(input.repoPath);
    const args = ['worktree', 'remove', ...(input.force ? ['--force'] : []), '--', input.path];
    const result = await this.#git(args, input.repoPath);
    if (result.code === 0) return { ok: true };
    const error = describeFailure(args, result);
    if (this.#removeDir === undefined) return fail(error);
    return this.#removeByFs(input, error, before);
  }

  async #removeByFs(
    input: RemoveWorktreeInput,
    gitError: string,
    before: string[] | undefined
  ): Promise<GitResult> {
    const { repoPath, path } = input;
    const target = comparablePath(path);
    const repo = comparablePath(repoPath);
    const skipped = (reason: string) => fail(`${gitError}; fallback skipped: ${reason}`);
    // 不删根/近根路径，也不删主仓库或包含主仓库的目录
    if (!isDeletablePath(path) || repo === target || repo.startsWith(`${target}/`)) {
      return skipped('unsafe path');
    }
    const listed = await this.#listWorktrees(repoPath);
    if (listed === undefined) return skipped('cannot list worktrees');
    const isRegistered = (entries: string[]) =>
      entries.slice(1).some((entry) => comparablePath(entry) === target);
    if (isRegistered(listed)) {
      if (!input.force) {
        // 非 force：git 的拒绝可能是因为有改动；只有确认干净时才认定是文件系统错误
        const status = await this.#git(['status', '--porcelain'], path);
        if (status.code !== 0 || status.stdout.trim() !== '') {
          return skipped('the worktree has changes or its status is unknown');
        }
      }
    } else if (before === undefined || !isRegistered(before)) {
      const leftover = await this.#checkLeftover(input, repo, target);
      if (leftover === 'missing') return this.#pruneAndVerify(repoPath, target, gitError);
      if (leftover !== 'ok') return skipped(leftover);
    }
    try {
      await this.#removeDir?.(path);
    } catch (error) {
      return fail(`${gitError}; fallback delete failed: ${errorMessage(error)}`);
    }
    return this.#pruneAndVerify(repoPath, target, gitError);
  }

  /** 未登记的路径能否当作残留目录删除：`'ok'`、`'missing'`（不存在）或拒绝原因。 */
  async #checkLeftover(input: RemoveWorktreeInput, repo: string, target: string): Promise<string> {
    const notRegistered = 'path is not a registered worktree';
    if (!input.force) return `${notRegistered} (not forced)`;
    if (this.#pathKind === undefined) return notRegistered;
    let kind: PathKind;
    try {
      kind = await this.#pathKind(input.path);
    } catch (error) {
      return `cannot inspect the path: ${errorMessage(error)}`;
    }
    if (kind === 'missing') return 'missing';
    if (input.ownedRoot === undefined) return `${notRegistered} (no owned worktrees root)`;
    if (!isStrictlyInside(input.path, input.ownedRoot)) {
      return `${notRegistered} and is outside the worktrees root ${input.ownedRoot}`;
    }
    if (target.startsWith(`${repo}/`)) return 'path is inside the repository';
    if (kind !== 'directory') return `${notRegistered} and is not a directory`;
    let gitKind: PathKind;
    try {
      gitKind = await this.#pathKind(joinPath(input.path, '.git'));
    } catch (error) {
      return `cannot inspect ${joinPath(input.path, '.git')}: ${errorMessage(error)}`;
    }
    // .git 文件是 worktree 链接（已失效）；.git 目录（或链接）说明是个真仓库
    if (gitKind !== 'missing' && gitKind !== 'file') return 'path contains a .git directory';
    return 'ok';
  }

  async #pruneAndVerify(repoPath: string, target: string, gitError: string): Promise<GitResult> {
    const pruned = await this.#git(['worktree', 'prune'], repoPath);
    if (pruned.code !== 0) {
      return fail(`${gitError}; ${describeFailure(['worktree', 'prune'], pruned)}`);
    }
    const after = await this.#listWorktrees(repoPath);
    if (after === undefined || after.some((entry) => comparablePath(entry) === target)) {
      return fail(`${gitError}; the worktree is still registered after deleting its directory`);
    }
    return { ok: true };
  }

  async #listWorktrees(repoPath: string): Promise<string[] | undefined> {
    const listed = await this.#git(['worktree', 'list', '--porcelain'], repoPath);
    return listed.code === 0 ? parseWorktreeList(listed.stdout) : undefined;
  }

  /** `git worktree prune`：清理目录已不存在的 worktree 登记。 */
  async prune(repoPath: string): Promise<GitResult> {
    return this.#simple(['worktree', 'prune'], repoPath);
  }

  /**
   * 在 `repoPath` 当前检出的分支上 `git merge --no-ff --no-edit <branch>`。
   * 失败时用 `git diff --name-only --diff-filter=U` 收集冲突文件，并 `git merge --abort` 还原。
   */
  async merge(input: { repoPath: string; branch: string }): Promise<MergeResult> {
    const { repoPath, branch } = input;
    if (!isSafeRefArg(branch)) return fail(`invalid branch: ${JSON.stringify(branch)}`);
    const mergeArgs = ['merge', '--no-ff', '--no-edit', branch];
    const merged = await this.#git(mergeArgs, repoPath);
    if (merged.code === 0) {
      const head = await this.#git(['rev-parse', 'HEAD'], repoPath);
      // 合并已经发生；读不到 HEAD 时 commit 为空串
      return { ok: true, commit: head.code === 0 ? head.stdout.trim() : '' };
    }
    const unmerged = await this.#git(['diff', '--name-only', '-z', '--diff-filter=U'], repoPath);
    const conflicts = unmerged.code === 0 ? splitNul(unmerged.stdout) : [];
    // 没有进行中的合并时 --abort 会失败，无副作用，忽略
    await this.#git(['merge', '--abort'], repoPath);
    if (conflicts.length > 0) {
      return {
        ok: false,
        error: `merging ${branch} conflicts in ${conflicts.length} file(s); merge aborted`,
        conflicts,
      };
    }
    return fail(describeFailure(mergeArgs, merged));
  }

  /** 删除分支：默认 `-d`（未合并时 git 拒绝），`force` 时 `-D`。 */
  async deleteBranch(input: {
    repoPath: string;
    branch: string;
    force?: boolean;
  }): Promise<GitResult> {
    if (!isSafeRefArg(input.branch)) return fail(`invalid branch: ${JSON.stringify(input.branch)}`);
    return this.#simple(['branch', input.force ? '-D' : '-d', input.branch], input.repoPath);
  }

  async #create(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    const { repoPath, workspaceId, baseRef, worktreesRoot } = input;
    if (!WORKSPACE_ID.test(workspaceId)) {
      return fail(`invalid workspaceId: ${JSON.stringify(workspaceId)}`);
    }
    if (!isSafeRefArg(baseRef)) return fail(`invalid baseRef: ${JSON.stringify(baseRef)}`);

    const resolved = await this.#git(
      ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
      repoPath
    );
    const baseCommit = resolved.stdout.trim();
    if (resolved.code !== 0 || baseCommit === '') {
      const detail = resolved.stderr.trim();
      return fail(
        `base ref "${baseRef}" does not resolve to a commit${detail ? `: ${detail}` : ''}`
      );
    }

    const refsArgs = ['for-each-ref', '--format=%(refname)', `refs/heads/${BRANCH_PREFIX}`];
    const refs = await this.#git(refsArgs, repoPath);
    if (refs.code !== 0) return fail(describeFailure(refsArgs, refs));
    const taken = new Set(refs.stdout.split('\n').map((line) => line.trim()));

    const slug = normalizeSlug(input.slug);
    let candidate: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && candidate === undefined; attempt++) {
      const next = slugCandidate(slug, attempt);
      if (!taken.has(`refs/heads/${BRANCH_PREFIX}${next}`)) candidate = next;
    }
    if (candidate === undefined) return fail(`no free branch name for slug "${slug}"`);

    const branch = `${BRANCH_PREFIX}${candidate}`;
    const path = joinPath(worktreesRoot, workspaceId, candidate);
    const addArgs = ['worktree', 'add', '--quiet', '-b', branch, '--', path, baseCommit];
    const added = await this.#git(addArgs, repoPath);
    if (added.code !== 0) {
      await this.#dropBranchCreatedAt(repoPath, branch, baseCommit);
      return fail(describeFailure(addArgs, added));
    }
    return {
      ok: true,
      worktree: { id: newId('wt'), workspaceId, path, branch, baseRef, baseCommit },
    };
  }

  /** `worktree add -b` 在目录冲突时会先建好分支再失败：只删仍指向 baseCommit 的那个分支。 */
  async #dropBranchCreatedAt(repoPath: string, branch: string, baseCommit: string): Promise<void> {
    const head = await this.#git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      repoPath
    );
    if (head.code === 0 && head.stdout.trim() === baseCommit) {
      await this.#git(['branch', '-D', branch], repoPath);
    }
  }

  async #simple(args: readonly string[], cwd: string): Promise<GitResult> {
    const result = await this.#git(args, cwd);
    return result.code === 0 ? { ok: true } : fail(describeFailure(args, result));
  }

  async #git(args: readonly string[], cwd: string): Promise<ExecResult> {
    try {
      return await this.#exec('git', [...GIT_CONFIG_ARGS, ...args], cwd);
    } catch (error) {
      return { code: -1, stdout: '', stderr: errorMessage(error) };
    }
  }
}
