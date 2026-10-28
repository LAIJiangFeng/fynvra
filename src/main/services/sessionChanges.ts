import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExecFn, Workspace, Worktree } from '@fynvra/core';
import { asRecord } from '@shared/guards';
import type { SessionSummary } from '@shared/types/chat';
import type {
  OrchestrationSnapshotView,
  SessionChanges,
  SessionChangesInput,
} from '@shared/types/orchestration';
import { parseWorkspaceId } from '@shared/types/workspace';
import { nodeExec } from './orchestration/nodeExec';
import { untrackedPatch } from './orchestration/queries';
import { parseSessionId } from './sessions/sessionStore';

const GIT = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_FILES = 200;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export function parseSessionChangesInput(raw: unknown): SessionChangesInput | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'workspaceId' && key !== 'sessionId'))
    return null;
  const workspaceId = parseWorkspaceId(record.workspaceId);
  if (!workspaceId) return null;
  if (!Object.hasOwn(record, 'sessionId')) return { workspaceId };
  const sessionId = parseSessionId(record.sessionId);
  return sessionId ? { workspaceId, sessionId } : null;
}

interface Dependencies {
  workspace: (id: string) => Workspace | undefined;
  session: (id: string) => SessionSummary | undefined;
  snapshot: (id: string) => Promise<OrchestrationSnapshotView | undefined>;
  exec?: ExecFn;
}

function unavailable(availability: SessionChanges['availability']): SessionChanges {
  return {
    availability,
    branch: '',
    headCommit: null,
    baseCommit: '',
    comparison: { kind: 'unborn' },
    files: [],
    stat: '',
    diff: '',
    uncommitted: { available: false, files: [], diff: '' },
    commits: [],
  };
}

const splitNul = (text: string) => text.split('\0').filter(Boolean);

/** A read-only query: registry lookup never opens an orchestration service or starts a session. */
export async function readSessionChanges(
  deps: Dependencies,
  input: SessionChangesInput
): Promise<SessionChanges> {
  const workspace = deps.workspace(input.workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const session = input.sessionId ? deps.session(input.sessionId) : undefined;
  if (input.sessionId && (!session || session.workspaceId !== workspace.id))
    throw new Error('Session does not belong to this workspace');
  if (workspace.vcs === 'none') return unavailable('no-git');

  let worktree: Worktree | undefined;
  if (session?.dispatchId || session?.worktreeId || session?.parentSessionId) {
    const snapshot = await deps.snapshot(workspace.id);
    const dispatch = snapshot?.dispatches.find((entry) => entry.id === session.dispatchId);
    const task = snapshot?.tasks.find((entry) => entry.id === dispatch?.taskId);
    const run = snapshot?.runs.find((entry) => entry.id === task?.runId);
    if (
      !dispatch ||
      dispatch.workerSessionId !== session.id ||
      dispatch.worktreeId !== session.worktreeId ||
      run?.workspaceId !== workspace.id
    )
      throw new Error('Worker session registration does not match its dispatch');
    worktree = snapshot?.worktrees.find((entry) => entry.id === dispatch.worktreeId);
    if (!worktree) return unavailable('worktree-removed');
    if (
      worktree.workspaceId !== workspace.id ||
      worktree.branch !== dispatch.branch ||
      resolve(session.cwd) !== resolve(worktree.path)
    )
      throw new Error('Worker session registration does not match its worktree');
  }

  let root: string;
  try {
    root = await realpath(worktree?.path ?? workspace.repoPath);
  } catch (error) {
    if (worktree && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return unavailable('worktree-removed');
    throw error;
  }
  const exec = deps.exec ?? nodeExec;
  const git = async (args: string[], cwd = root) => {
    const result = await exec('git', [...GIT, ...args], cwd);
    // nodeExec also caps process output/time. Never expose a truncated patch as a complete result.
    if (Buffer.byteLength(result.stdout) > MAX_PATCH_BYTES)
      throw new Error('Changes exceed the 8 MiB preview limit');
    return result;
  };
  const required = async (args: string[], cwd = root) => {
    const result = await git(args, cwd);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed`);
    return result.stdout;
  };
  const gitRoot = await realpath((await required(['rev-parse', '--show-toplevel'])).trim());
  if (gitRoot !== root) throw new Error('Registered directory is not the Git worktree root');
  const mainRoot = await realpath(workspace.repoPath);
  const mainGitRoot = await realpath(
    (await required(['rev-parse', '--show-toplevel'], mainRoot)).trim()
  );
  if (mainGitRoot !== mainRoot) throw new Error('Workspace is not the Git repository root');
  const commonDir = async (cwd: string) =>
    realpath(resolve(cwd, (await required(['rev-parse', '--git-common-dir'], cwd)).trim()));
  if ((await commonDir(root)) !== (await commonDir(mainRoot)))
    throw new Error('Worktree belongs to another Git repository');
  if (worktree) {
    if (root === mainRoot) throw new Error('Worker worktree points to the main directory');
    const registered = splitNul(await required(['worktree', 'list', '--porcelain', '-z'], mainRoot))
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice(9)));
    if (root !== resolve(worktree.path) || !registered.includes(root))
      throw new Error('Directory is not a registered Git worktree');
  }

  const branchResult = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchResult.code !== 0 && branchResult.code !== 1)
    throw new Error(branchResult.stderr.trim() || 'Cannot read the current branch');
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '';
  const resolveCommit = async (ref: string) => {
    const result = await git([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    if (result.code === 1) return null;
    if (result.code !== 0 || !SHA.test(result.stdout.trim()))
      throw new Error(result.stderr.trim() || 'Cannot resolve Git commit');
    return result.stdout.trim();
  };
  const head = await resolveCommit('HEAD');
  if (!head && !branch) throw new Error('Cannot resolve detached HEAD');
  const format = (await required(['rev-parse', '--show-object-format'])).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported Git object format');
  const emptyTree = createHash(format).update('tree 0\0').digest('hex');

  let base = emptyTree;
  let comparison: SessionChanges['comparison'] = { kind: 'unborn' };
  if (head) {
    let found = false;
    if (worktree && branch === worktree.branch && SHA.test(worktree.baseCommit)) {
      const registeredBase = await resolveCommit(worktree.baseCommit);
      if (registeredBase) {
        base = registeredBase;
        comparison = { kind: 'worker-base' };
        found = true;
      }
    }
    if (!found && workspace.defaultBranch) {
      const defaultBranch = workspace.defaultBranch;
      if ((await git(['check-ref-format', `refs/heads/${defaultBranch}`])).code !== 0)
        throw new Error('Invalid registered default branch');
      for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
        const target = await resolveCommit(ref);
        if (!target) continue;
        const merge = await git(['merge-base', head, target]);
        if (merge.code !== 0 && merge.code !== 1)
          throw new Error(merge.stderr.trim() || 'Cannot read merge base');
        const sha = merge.stdout.trim();
        if (merge.code === 0 && SHA.test(sha) && sha !== head) {
          base = sha;
          comparison = { kind: 'default-branch', ref };
          found = true;
        }
        // The first available default ref is authoritative, even when already synchronized.
        break;
      }
    }
    if (!found) {
      base = (await resolveCommit(`${head}^1`)) ?? emptyTree;
      comparison = { kind: 'latest-commit' };
    }
  }

  const [names, tracked, others] = await Promise.all([
    required([...DIFF, '--name-only', '-z', head ?? emptyTree, '--']),
    required([...DIFF, head ?? emptyTree, '--']),
    required(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const untracked = splitNul(others);
  if (untracked.length > MAX_FILES)
    throw new Error('Untracked files exceed the 200-file preview limit');
  let workingPatch = tracked;
  for (const path of untracked) {
    workingPatch += await untrackedPatch(root, path, true);
    if (Buffer.byteLength(workingPatch) > MAX_PATCH_BYTES)
      throw new Error('Changes exceed the 8 MiB preview limit');
  }

  let files: string[] = [];
  let diff = '';
  let stat = '';
  let commits: SessionChanges['commits'] = [];
  if (head) {
    const [names, patch, summary, log] = await Promise.all([
      required([...DIFF, '--name-only', '-z', base, head, '--']),
      required([...DIFF, base, head, '--']),
      required([...DIFF, '--stat=200', base, head, '--']),
      required([
        'log',
        '-z',
        '--no-color',
        comparison.kind === 'latest-commit' ? '--max-count=1' : '--max-count=500',
        '--format=%H%x1f%an%x1f%aI%x1f%s',
        ...(comparison.kind === 'latest-commit' || base === emptyTree
          ? [head]
          : [`${base}..${head}`]),
        '--',
      ]),
    ]);
    files = splitNul(names);
    diff = patch;
    stat = summary.trimEnd();
    commits = splitNul(log).map((record) => {
      const [sha = '', author = '', date = '', ...subject] = record
        .replace(/^\n+/, '')
        .split('\x1f');
      return { sha, author, date, subject: subject.join('\x1f') };
    });
  }
  // A checkout/commit during the query invalidates the mixed snapshot; ask the user to refresh.
  if (
    (await resolveCommit('HEAD')) !== head ||
    (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() !== branch
  )
    throw new Error('Git HEAD changed while reading changes; refresh to try again');
  return {
    availability: 'available',
    branch,
    headCommit: head,
    baseCommit: head ? base : '',
    comparison,
    files,
    stat,
    diff,
    commits,
    uncommitted: {
      available: true,
      files: [...new Set([...splitNul(names), ...untracked])],
      diff: workingPatch,
    },
  };
}
