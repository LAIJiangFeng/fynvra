import { realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { translate } from '../i18n';
import { type GitRunner, runGit, samePath } from './gitRepository';

export type GitInitResult =
  | { ok: true; alreadyRepo: boolean }
  | { ok: false; code?: 'git-missing'; error: string };

/** 未设置提交身份时写进仓库本地配置的默认邮箱 */
export const DEFAULT_GIT_EMAIL = 'fynvra@localhost';

export interface GitInitOptions {
  run?: GitRunner;
  platform?: NodeJS.Platform;
  /** 默认提交者名：系统用户名，取不到用 Fynvra */
  userName?: () => string;
}

function systemUserName(): string {
  try {
    return userInfo().username || 'Fynvra';
  } catch {
    return 'Fynvra';
  }
}

/**
 * 把普通目录初始化为 git 仓库：git init → 缺失的提交身份写进本地配置 → 初始提交。
 * 目录已是仓库根目录时什么都不做（alreadyRepo）；在外层仓库里时报错。
 * 失败不删 `.git`：init、add、commit 都可以重复执行，用户重试即可。
 */
export async function initGitRepository(
  dir: string,
  { run = runGit, platform = process.platform, userName = systemUserName }: GitInitOptions = {}
): Promise<GitInitResult> {
  const version = await run(['--version'], dir);
  if (!version.ok) {
    return { ok: false, code: 'git-missing', error: translate('workspaces.gitMissing') };
  }

  const toplevel = await run(['rev-parse', '--show-toplevel'], dir);
  if (toplevel.ok) {
    const output = resolve(toplevel.stdout.trim());
    const root = await realpath(output).catch(() => output);
    if (samePath(root, dir, platform)) return { ok: true, alreadyRepo: true };
    return { ok: false, error: translate('workspaces.gitInitInsideRepo', { root }) };
  }

  const step = async (args: string[]): Promise<string | undefined> => {
    const result = await run(args, dir);
    return result.ok
      ? undefined
      : translate('workspaces.gitInitFailed', { command: `git ${args[0]}`, error: result.error });
  };

  const initError = await step(['init']);
  if (initError) return { ok: false, error: initError };

  // 读生效值（含全局配置）；只补缺的那项，写进仓库本地配置，worktree 共享它
  for (const [key, fallback] of [
    ['user.name', userName],
    ['user.email', () => DEFAULT_GIT_EMAIL],
  ] as const) {
    const current = await run(['config', key], dir);
    if (current.ok && current.stdout.trim()) continue;
    const error = await step(['config', key, fallback()]);
    if (error) return { ok: false, error };
  }

  const addError = await step(['add', '-A']);
  if (addError) return { ok: false, error: addError };
  const commitError = await step([
    'commit',
    '--no-verify',
    '--allow-empty',
    '-m',
    '初始化（Fynvra）',
  ]);
  if (commitError) return { ok: false, error: commitError };
  return { ok: true, alreadyRepo: false };
}
