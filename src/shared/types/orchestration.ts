import type { Dispatch, Message, Run, Task, Worktree } from '@fynvra/core';
export interface OrchestrationSnapshotView {
  runs: Run[];
  tasks: Task[];
  dispatches: Dispatch[];
  worktrees: Worktree[];
  messages: Message[];
}

/** Only opaque registry ids cross IPC. Paths and refs are resolved in Main. */
export interface SessionChangesInput {
  workspaceId: string;
  sessionId?: string;
}

export const MAX_COMMIT_MESSAGE_LENGTH = 2000;

export type ChangesAction = 'stage' | 'discard' | 'commit';

export type ChangesActionInput = SessionChangesInput &
  (
    | { action: 'stage' | 'discard'; scope: 'all' }
    /** 1~2 个仓库相对路径（新路径 + 重命名前的旧路径）。 */
    | { action: 'stage' | 'discard'; scope: 'file'; paths: string[] }
    | { action: 'commit'; scope: 'all'; message: string }
  );

/**
 * Current writes report their outcome without a fallible follow-up preview.
 * Keep the earlier files response assignable for existing API consumers.
 */
export type ChangesActionResult =
  | { outcome: 'applied' | 'no-changes' }
  | { outcome?: never; files: string[] };

export interface SessionChanges {
  availability: 'available' | 'worktree-removed' | 'no-git';
  /** Actual checkout, empty when detached or unavailable. */
  branch: string;
  headCommit: string | null;
  baseCommit: string;
  comparison:
    | { kind: 'worker-base' }
    | { kind: 'default-branch'; ref: string }
    | { kind: 'latest-commit' }
    | { kind: 'unborn' };
  files: string[];
  stat: string;
  diff: string;
  uncommitted: { available: boolean; files: string[]; diff: string };
  commits: { sha: string; subject: string; author: string; date: string }[];
}
