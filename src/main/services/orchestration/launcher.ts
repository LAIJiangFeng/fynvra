export interface WorkerSessionLauncher {
  createWorkerSession(input: {
    workspaceId: string;
    runId: string;
    dispatchId: string;
    roleId: string;
    cwd: string;
    /** 普通目录（工作区没有 git）的尝试没有 worktree，cwd 就是工作区目录 */
    worktreeId?: string;
    brief: string;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  promptSession(
    sessionId: string,
    text: string
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  readTranscript(
    sessionId: string,
    cursor: number
  ): Promise<
    { ok: true; text: string; total: number; done: boolean } | { ok: false; error: string }
  >;
  disposeSession(sessionId: string): Promise<void>;
}
