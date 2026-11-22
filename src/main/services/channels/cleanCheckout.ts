// 每个工作区、每个渠道插件一个干净检出（ARCHITECTURE §7.14「会话」）：只含 origin/<默认分支> 已提交文件的 detached worktree。
// 只用远端引用，不用本地分支，免得把用户没推送的提交暴露给分诊。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMarketPluginId } from '@shared/types/pluginMarket';
import type { Workspace } from '@shared/types/workspace';

// Telegram 插件沿用旧目录名：已有分诊会话的 cwd 记录的就是它，改名会让它们读到过期的检出
export const TELEGRAM_CLEAN_CHECKOUT_DIR = 'telegram-clean';

/** 插件的干净检出目录名；pluginId 不合规时抛错，不拼进路径 */
export function cleanCheckoutDir(pluginId: string): string {
  if (!isMarketPluginId(pluginId)) throw new Error('invalid plugin id');
  return pluginId === 'com.fynvra.telegram' ? TELEGRAM_CLEAN_CHECKOUT_DIR : `clean-${pluginId}`;
}
/** 每个工作区 fetch 的最小间隔 */
export const FETCH_INTERVAL_MS = 10 * 60_000;

export type GitExec = (
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

export const execGit: GitExec = (args, { cwd, env, timeoutMs = 60_000 }) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) resolve({ ok: false, error: stderr.trim() || error.message });
        else resolve({ ok: true, stdout });
      }
    );
  });

export interface CleanCheckoutDeps {
  git?: GitExec;
  /** 工作区的 worktree 托管根目录（与 agentHost.setWorktreesRootLookup 同一个 resolver） */
  worktreesRoot(workspace: Workspace): Promise<string>;
  /** §7.7 的命令网络环境，每次现读 */
  commandEnv(): NodeJS.ProcessEnv;
  exists?(path: string): boolean;
  now?(): number;
}

export interface CleanCheckout {
  /** `<worktreesRoot>/<workspaceId>/<cleanCheckoutDir(pluginId)>` */
  pathOf(workspace: Workspace, pluginId: string): Promise<string>;
  /** origin/<默认分支> 的提交；不是 git 工作区、没有默认分支或远端引用不存在时返回错误 */
  originCommit(
    workspace: Workspace
  ): Promise<{ ok: true; commit: string } | { ok: false; error: string }>;
  /** 不存在就用 `git worktree add --detach` 建出来，返回路径 */
  ensure(
    workspace: Workspace,
    pluginId: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** 尽力 fetch（限频，失败不阻断），再切到 origin/<默认分支> 并清掉未跟踪文件 */
  refresh(
    workspace: Workspace,
    pluginId: string
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** 检出时不跑 hooks（post-checkout 等）：指向一个不存在的目录 */
function noHooks(path: string): string[] {
  return ['-c', `core.hooksPath=${join(path, '..', '.telegram-no-hooks')}`];
}

function remoteRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

export function createCleanCheckout(deps: CleanCheckoutDeps): CleanCheckout {
  const git = deps.git ?? execGit;
  const exists = deps.exists ?? existsSync;
  const now = deps.now ?? Date.now;
  const lastFetch = new Map<string, number>();

  const pathOf = async (workspace: Workspace, pluginId: string) =>
    join(await deps.worktreesRoot(workspace), workspace.id, cleanCheckoutDir(pluginId));

  const branchOf = (workspace: Workspace): string | undefined =>
    workspace.vcs === 'git' &&
    workspace.defaultBranch &&
    !workspace.defaultBranch.startsWith('-') &&
    !/\s/.test(workspace.defaultBranch)
      ? workspace.defaultBranch
      : undefined;

  const originCommit: CleanCheckout['originCommit'] = async (workspace) => {
    const branch = branchOf(workspace);
    if (!branch)
      return { ok: false, error: 'workspace is not a git repository with a default branch' };
    const result = await git(
      ['rev-parse', '--verify', '--quiet', `${remoteRef(branch)}^{commit}`],
      { cwd: workspace.repoPath }
    );
    const commit = result.ok ? result.stdout.trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      return { ok: false, error: `origin/${branch} does not exist` };
    }
    return { ok: true, commit };
  };

  const ensure: CleanCheckout['ensure'] = async (workspace, pluginId) => {
    if (!isMarketPluginId(pluginId)) return { ok: false, error: 'invalid plugin id' };
    const origin = await originCommit(workspace);
    if (!origin.ok) return origin;
    const path = await pathOf(workspace, pluginId);
    if (exists(path)) return { ok: true, path };
    // 目录被删掉时先清掉 git 里残留的登记
    await git(['worktree', 'prune'], { cwd: workspace.repoPath });
    const added = await git(
      [...noHooks(path), 'worktree', 'add', '--detach', path, origin.commit],
      { cwd: workspace.repoPath }
    );
    return added.ok ? { ok: true, path } : { ok: false, error: added.error };
  };

  return {
    pathOf,
    originCommit,
    ensure,
    async refresh(workspace, pluginId) {
      if (!isMarketPluginId(pluginId)) return { ok: false, error: 'invalid plugin id' };
      const branch = branchOf(workspace);
      if (!branch) return { ok: false, error: 'workspace has no default branch' };
      const last = lastFetch.get(workspace.id);
      if (last === undefined || now() - last >= FETCH_INTERVAL_MS) {
        lastFetch.set(workspace.id, now());
        // 尽力而为：失败（离线、没权限）不阻断，用本地已有的远端引用
        await git(['fetch', 'origin', branch], {
          cwd: workspace.repoPath,
          env: { ...deps.commandEnv(), GIT_TERMINAL_PROMPT: '0' },
          timeoutMs: 120_000,
        });
      }
      const ensured = await ensure(workspace, pluginId);
      if (!ensured.ok) return ensured;
      const checkout = await git(
        [...noHooks(ensured.path), 'checkout', '--detach', '--force', remoteRef(branch)],
        { cwd: ensured.path }
      );
      if (!checkout.ok) return { ok: false, error: checkout.error };
      const clean = await git(['clean', '-ffdx'], { cwd: ensured.path });
      return clean.ok ? { ok: true } : { ok: false, error: clean.error };
    },
  };
}
