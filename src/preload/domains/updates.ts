import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UpdateResult, UpdateState } from '@shared/types/updates';

export interface UpdatesApi {
  state(): Promise<UpdateResult>;
  check(): Promise<UpdateResult>;
  /** Main 弹出安装确认，再进入窗口退出保护。 */
  install(): Promise<UpdateResult>;
  onChanged(callback: (state: UpdateState) => void): () => void;
}

export function createUpdatesApi(
  ipc: { invoke<T>(channel: string): Promise<T> },
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => () => void
): UpdatesApi {
  return {
    state: () => ipc.invoke(IPC_CHANNELS.UPDATES_STATE),
    check: () => ipc.invoke(IPC_CHANNELS.UPDATES_CHECK),
    install: () => ipc.invoke(IPC_CHANNELS.UPDATES_INSTALL),
    onChanged: (callback) =>
      subscribe(IPC_CHANNELS.UPDATES_CHANGED, (state) => callback(state as UpdateState)),
  };
}
