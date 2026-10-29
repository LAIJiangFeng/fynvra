import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { UiFlushReply, UiFlushRequest, WorkspaceUiSnapshot } from '@shared/types/workspaceUi';
import type { Unsubscribe } from '../types';

export interface WorkspaceUiApi {
  selection(workspaceId?: string): Promise<IpcResult<{ workspaceId: string | null }>>;
  load(
    workspaceId: string
  ): Promise<IpcResult<{ token: string; snapshot: WorkspaceUiSnapshot; warning: boolean }>>;
  save(input: {
    workspaceId: string;
    token: string;
    seq: number;
    snapshot: WorkspaceUiSnapshot;
  }): Promise<IpcResult>;
  onFlush(callback: (request: UiFlushRequest) => void): Unsubscribe;
  flushed(reply: UiFlushReply): Promise<IpcResult>;
}
export function createWorkspaceUiApi(
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> },
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => Unsubscribe
): WorkspaceUiApi {
  return {
    selection: (workspaceId) =>
      ipc.invoke(IPC_CHANNELS.WORKSPACE_UI_SELECTION, workspaceId) as ReturnType<
        WorkspaceUiApi['selection']
      >,
    load: (workspaceId) =>
      ipc.invoke(IPC_CHANNELS.WORKSPACE_UI_LOAD, workspaceId) as ReturnType<WorkspaceUiApi['load']>,
    save: (input) => ipc.invoke(IPC_CHANNELS.WORKSPACE_UI_SAVE, input) as Promise<IpcResult>,
    onFlush: (callback) =>
      subscribe(IPC_CHANNELS.WORKSPACE_UI_FLUSH, (raw) => {
        const request = raw as Partial<UiFlushRequest> | null;
        if (
          request &&
          typeof request.requestId === 'string' &&
          ['check', 'keep', 'discard', 'resume'].includes(request.mode ?? '')
        )
          callback(request as UiFlushRequest);
      }),
    flushed: (reply) => ipc.invoke(IPC_CHANNELS.WORKSPACE_UI_FLUSHED, reply) as Promise<IpcResult>,
  };
}
