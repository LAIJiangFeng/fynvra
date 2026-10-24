import type { Dispatch, Message, Run, Task, Worktree } from '@fynvra/core';
export interface OrchestrationSnapshotView {
  runs: Run[];
  tasks: Task[];
  dispatches: Dispatch[];
  worktrees: Worktree[];
  messages: Message[];
}
