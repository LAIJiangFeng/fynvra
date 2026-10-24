export interface WorkerSessionLauncher {
  createWorkerSession(input: {
    workspaceId: string;
    runId: string;
    dispatchId: string;
    roleId: string;
    cwd: string;
    worktreeId: string;
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
