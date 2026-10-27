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
