import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import type { Unsubscribe } from '../types';

export interface OrchestrationApi {
  snapshot(workspaceId: string): Promise<IpcResult<OrchestrationSnapshotView>>;
  /** 读 dispatch 对应 worker 会话的输出（与 read_worker_output 同源） */
  readWorkerOutput(input: {
    dispatchId: string;
    cursor: number;
  }): Promise<IpcResult<{ text: string; total: number; done: boolean }>>;
  reviewDiff(
    dispatchId: string
  ): Promise<
    IpcResult<{ branch: string; baseCommit: string; files: string[]; stat: string; diff: string }>
  >;
  onChanged(cb: (workspaceId: string) => void): Unsubscribe;
}

/**
 * 用到的 `ipcRenderer` 子集。本文件不 import electron：`types.ts` 经它拿 {@link OrchestrationApi}，
 * 而 Renderer 的 tsconfig 包含 `types.ts`，electron 的类型声明会把 Node 全局类型带进 Renderer。
 */
export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** `window.fynvra.orchestration`（ARCHITECTURE §9.4）：只传 id / cursor，推送回调拿不到 IpcRendererEvent。 */
export function createOrchestrationApi(ipc: PreloadIpc): OrchestrationApi {
  const call = <T>(channel: string, ...args: unknown[]) =>
    ipc.invoke(channel, ...args) as Promise<T>;
  return {
    snapshot: (workspaceId) => call(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, workspaceId),
    readWorkerOutput: (input) =>
      call(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, {
        dispatchId: input.dispatchId,
        cursor: input.cursor,
      }),
    reviewDiff: (dispatchId) => call(IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF, dispatchId),
    onChanged: (callback) => {
      const listener = (_event: unknown, workspaceId: unknown) => {
        if (typeof workspaceId === 'string') callback(workspaceId);
      };
      ipc.on(IPC_CHANNELS.ORCHESTRATION_CHANGED, listener);
      return () => {
        ipc.removeListener(IPC_CHANNELS.ORCHESTRATION_CHANGED, listener);
      };
    },
  };
}
