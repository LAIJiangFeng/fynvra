import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export type GitRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; missingGit?: boolean };

/** 在 cwd 下执行一条 git 命令；永不 reject，便于注入假实现测试。 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (!error) {
          done({ ok: true, stdout });
          return;
        }
        // cwd 已在调用前确认存在，此时的 ENOENT 只可能是找不到 git 本身
        const missingGit = (error as NodeJS.ErrnoException).code === 'ENOENT';
        done({ ok: false, error: stderr.trim() || error.message, missingGit });
      }
    );
  });

export type RepositoryInspection =
  | { ok: true; root: string; name: string; defaultBranch: string }
  | {
      ok: false;
      code: 'not-git-repo' | 'not-repo-root' | 'git-unavailable' | 'failed';
      error: string;
    };

/**
 * 确认 dir 是某个 git 工作区的根目录，并探测默认分支。
 * 仓库子目录不会被静默提升为外层仓库（可能挂错仓库），而是返回 not-repo-root 并给出根路径。
 */
export async function inspectGitRepository(
  dir: string,
  run: GitRunner = runGit
): Promise<RepositoryInspection> {
  let selected: string;
  try {
    selected = await realpath(dir);
  } catch {
    return { ok: false, code: 'failed', error: `目录不存在或无法访问：${dir}` };
  }

  const toplevel = await run(['rev-parse', '--show-toplevel'], selected);
  if (!toplevel.ok) {
    return toplevel.missingGit
      ? {
          ok: false,
          code: 'git-unavailable',
          error: '未找到 git，请先安装 git 并确保它在 PATH 中。',
        }
      : { ok: false, code: 'not-git-repo', error: `所选目录不是 git 仓库：${selected}` };
  }

  let root: string;
  try {
    root = await realpath(resolve(toplevel.stdout.trim()));
  } catch {
    return { ok: false, code: 'failed', error: `无法解析仓库根目录：${toplevel.stdout.trim()}` };
  }
  if (!samePath(root, selected)) {
    return {
      ok: false,
      code: 'not-repo-root',
      error: `所选目录位于仓库 ${root} 内，请选择仓库根目录。`,
    };
  }
  return {
    ok: true,
    root,
    name: basename(root),
    defaultBranch: await detectDefaultBranch(root, run),
  };
}

/** origin/HEAD → 本地 main / master → 当前分支 → 'main'。 */
async function detectDefaultBranch(root: string, run: GitRunner): Promise<string> {
  const remoteHead = await run(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    root
  );
  if (remoteHead.ok) {
    const branch = remoteHead.stdout.trim().replace(/^origin\//, '');
    if (branch) return branch;
  }
  for (const candidate of ['main', 'master']) {
    const local = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], root);
    if (local.ok) return candidate;
  }
  const head = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  return (head.ok && head.stdout.trim()) || 'main';
}

/** 同一路径判定：Windows 文件系统大小写不敏感。 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
