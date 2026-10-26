import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostResult, ReadWorkerOutputOutput, ReviewDiffOutput } from '@fynvra/agent-runtime';
import {
  type Dispatch,
  type ExecFn,
  type GitWorktreeManager,
  isDispatchSettled,
  type OrchestrationStore,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { fail } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';

// orchestration 工具（OrchestrationHost）与 orchestration IPC（面板）共用的只读查询

/** `repoPath` 当前检出的分支；detached HEAD 或 git 出错时为 `undefined`。 */
export async function currentBranch(exec: ExecFn, repoPath: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath);
    const branch = result.stdout.trim();
    return result.code === 0 && branch !== '' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** 在主仓库读 worker 提交；合并后优先使用固定范围，清理目录、删除或复用分支不影响历史改动。 */
export async function reviewDispatchDiff(
  deps: { git: GitWorktreeManager; exec: ExecFn; store: OrchestrationStore; repoPath: string },
  dispatch: Dispatch
): Promise<HostResult<ReviewDiffOutput>> {
  const mergedDiff = deps.store.tasks.get(dispatch.taskId)?.mergedDiff;
  const worktree = deps.store.worktrees.get(dispatch.worktreeId);
  const baseCommit = mergedDiff?.baseCommit ?? worktree?.baseCommit;
  const headRef = mergedDiff?.headCommit ?? (worktree && `refs/heads/${worktree.branch}`);
  if (baseCommit === undefined || headRef === undefined) {
    return fail(
      `the worktree of dispatch ${dispatch.id} was already cleaned up; no saved diff commits`
    );
  }
  const diff = await deps.git.diff({ path: deps.repoPath, baseCommit }, baseCommit, headRef);
  if (!diff.ok) return fail(`could not read the diff: ${diff.error}`);
  let stat = '';
  try {
    const args = ['-c', 'core.quotepath=false', 'diff', '--stat=200', '--no-color'];
    const result = await deps.exec('git', [...args, `${baseCommit}...${headRef}`], deps.repoPath);
    if (result.code === 0) stat = result.stdout.trimEnd();
  } catch {
    // stat 只是摘要；diff 已经拿到，取不到 stat 时留空
  }
  return {
    ok: true,
    branch: dispatch.branch,
    baseCommit,
    files: diff.files,
    stat,
    diff: diff.patch,
  };
}

/** 面板「未提交的更改」：worker worktree 相对其 HEAD 的工作区改动（已暂存 + 未暂存 + 未跟踪）。 */
export interface UncommittedChanges {
  /** worktree 已删除 / 不是该 worker 的检出时为 false，其余字段为空 */
  available: boolean;
  files: string[];
  diff: string;
}

/** 面板「提交」：`base..head` 的一条提交，新的在前。 */
export interface CommitSummary {
  sha: string;
  subject: string;
  author: string;
  /** ISO 8601 作者时间 */
  date: string;
}

/** 面板用的 reviewDiff：工具输出之外再带未提交改动与提交列表（agent 的 review_diff 不变）。 */
export type PanelReviewDiff = ReviewDiffOutput & {
  uncommitted: UncommittedChanges;
  commits: CommitSummary[];
};

const UNAVAILABLE: UncommittedChanges = { available: false, files: [], diff: '' };
/** 未跟踪文件最多列这么多个、内容超过这么大就不内联文本。 */
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_COMMITS = 500;
/** 只读：不让 git 顺手刷新 index（index.lock） */
const READ_ONLY_GIT = ['--no-optional-locks', '-c', 'core.quotepath=false'];

function splitNul(text: string): string[] {
  return text.split('\0').filter((part) => part !== '');
}

/** 面板 reviewDiff：在 {@link reviewDispatchDiff} 之上补未提交改动与提交列表；取不到时降级为空。 */
export async function reviewDispatchPanelDiff(
  deps: { git: GitWorktreeManager; exec: ExecFn; store: OrchestrationStore; repoPath: string },
  dispatch: Dispatch
): Promise<HostResult<PanelReviewDiff>> {
  const base = await reviewDispatchDiff(deps, dispatch);
  if (!base.ok) return base;
  const mergedDiff = deps.store.tasks.get(dispatch.taskId)?.mergedDiff;
  const worktree = deps.store.worktrees.get(dispatch.worktreeId);
  const headRef = mergedDiff?.headCommit ?? (worktree && `refs/heads/${worktree.branch}`);
  const [uncommitted, commits] = await Promise.all([
    worktree ? worktreeUncommitted(deps.exec, worktree.path, worktree.branch) : UNAVAILABLE,
    headRef ? commitsBetween(deps.exec, deps.repoPath, base.baseCommit, headRef) : [],
  ]);
  return { ...base, uncommitted, commits };
}

/**
 * worktree 的工作区改动：已跟踪文件用 `git diff HEAD`，未跟踪文件拼成新增文件的 patch。
 * 目录不在、或检出的不是该 worker 分支（目录残留在别的仓库里）时 `available: false`。
 */
export async function worktreeUncommitted(
  exec: ExecFn,
  worktreePath: string,
  branch: string
): Promise<UncommittedChanges> {
  try {
    if ((await currentBranch(exec, worktreePath)) !== branch) return UNAVAILABLE;
    const [names, patch, untracked] = await Promise.all([
      exec('git', [...READ_ONLY_GIT, 'diff', '--name-only', '-z', 'HEAD'], worktreePath),
      exec('git', [...READ_ONLY_GIT, 'diff', '--no-color', '--no-ext-diff', 'HEAD'], worktreePath),
      exec(
        'git',
        [...READ_ONLY_GIT, 'ls-files', '--others', '--exclude-standard', '-z'],
        worktreePath
      ),
    ]);
    if (names.code !== 0 || patch.code !== 0) return UNAVAILABLE;
    const files = splitNul(names.stdout);
    let diff = patch.stdout;
    if (untracked.code === 0) {
      const added = splitNul(untracked.stdout).slice(0, MAX_UNTRACKED_FILES);
      for (const path of added) {
        files.push(path);
        const text = await untrackedPatch(worktreePath, path);
        diff += diff === '' || diff.endsWith('\n') ? text : `\n${text}`;
      }
    }
    return { available: true, files, diff };
  } catch {
    return UNAVAILABLE;
  }
}

/** 未跟踪文件 → `new file` patch；二进制、过大、非普通文件（符号链接等）只给文件头，不读内容。 */
async function untrackedPatch(root: string, path: string): Promise<string> {
  const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644'];
  let content: Buffer | undefined;
  try {
    const info = await lstat(join(root, path));
    if (info.isFile() && info.size <= MAX_UNTRACKED_BYTES)
      content = await readFile(join(root, path));
  } catch {
    content = undefined;
  }
  if (content === undefined) return `${header.join('\n')}\n`;
  if (content.includes(0)) {
    return `${[...header, `Binary files /dev/null and b/${path} differ`].join('\n')}\n`;
  }
  if (content.length === 0) return `${header.join('\n')}\n`;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  const missingNewline = !text.endsWith('\n');
  if (!missingNewline) lines.pop();
  const out = [...header, '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`];
  for (const line of lines) out.push(`+${line}`);
  if (missingNewline) out.push('\\ No newline at end of file');
  return `${out.join('\n')}\n`;
}

/** `git log base..head`，新的在前；出错时为空（与 stat 一样只是摘要）。 */
export async function commitsBetween(
  exec: ExecFn,
  repoPath: string,
  baseCommit: string,
  headRef: string
): Promise<CommitSummary[]> {
  try {
    const result = await exec(
      'git',
      [
        ...READ_ONLY_GIT,
        'log',
        '-z',
        '--no-color',
        `--max-count=${MAX_COMMITS}`,
        '--format=%H%x1f%an%x1f%aI%x1f%s',
        `${baseCommit}..${headRef}`,
      ],
      repoPath
    );
    if (result.code !== 0) return [];
    return splitNul(result.stdout).flatMap((record) => {
      const [sha, author, date, ...subject] = record.replace(/^\n+/, '').split('\x1f');
      if (!sha || author === undefined || date === undefined) return [];
      return [{ sha, author, date, subject: subject.join('\x1f') }];
    });
  } catch {
    return [];
  }
}

/**
 * dispatch 对应 worker 会话的输出（`launcher.readTranscript`，cursor 是字符偏移）。
 * `done` 要求会话不再产出且这次尝试已结算：进行中的尝试即使会话暂时空闲也不算完。
 */
export async function readDispatchOutput(
  deps: { store: OrchestrationStore; launcher: WorkerSessionLauncher },
  dispatch: Dispatch,
  cursor: number
): Promise<HostResult<ReadWorkerOutputOutput>> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return fail('cursor must be a non-negative integer');
  }
  let result: Awaited<ReturnType<WorkerSessionLauncher['readTranscript']>>;
  try {
    result = await deps.launcher.readTranscript(dispatch.workerSessionId, cursor);
  } catch (error) {
    result = fail(errorMessage(error));
  }
  if (!result.ok) return fail(`could not read the worker output: ${result.error}`);
  const current = deps.store.dispatches.get(dispatch.id) ?? dispatch;
  return {
    ok: true,
    text: result.text,
    total: result.total,
    done: result.done && isDispatchSettled(current),
  };
}
