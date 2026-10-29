import type { ThinkingLevel } from '@fynvra/core';

export interface WorkerSessionLauncher {
  createWorkerSession(input: {
    workspaceId: string;
    runId: string;
    dispatchId: string;
    roleId: string;
    cwd: string;
    /** 普通目录（工作区没有 git）的尝试没有 worktree，cwd 就是工作区目录 */
    worktreeId?: string;
    /** dispatch_task 指定的模型（`modelId` 或 `providerId/modelId`）；缺省按角色 / 主 agent 的模型 */
    model?: string;
    /** dispatch_task 指定的思考档位；缺省按模型 / 角色 / 主 agent 的默认 */
    thinking?: ThinkingLevel;
    /** Fast 请求：true 仅在协议支持时开启，false 关闭继承；缺省保持原默认 */
    fastMode?: boolean;
    brief: string;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  /** Ordinary instructions return after delivery; fresh-attempt waits are cancellable until delivery */
  promptSession(
    sessionId: string,
    text: string,
    options?: { freshAttempt?: boolean; signal?: AbortSignal }
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  readTranscript(
    sessionId: string,
    cursor: number
  ): Promise<
    { ok: true; text: string; total: number; done: boolean } | { ok: false; error: string }
  >;
  /** Main-only evidence; undefined means present or unknown, never infer failure from idle/timeouts */
  sessionFailure?(sessionId: string): string | undefined;
  /** Notify when a session is removed or a run definitively terminates abnormally */
  onSessionFailure?(listener: () => void): () => void;
  disposeSession(sessionId: string): Promise<void>;
}
