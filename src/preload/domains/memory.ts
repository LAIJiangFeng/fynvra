import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type {
  MemoryCreateInput,
  MemoryListView,
  MemoryRemoveInput,
  MemoryUpdateInput,
  MemoryView,
} from '@shared/types/memory';
import type { Unsubscribe } from '../types';

/** 项目记忆（§7.15）：Renderer 只传工作区 id、记忆 id 与字段 */
export interface MemoryApi {
  list(workspaceId: string): Promise<IpcResult<MemoryListView>>;
  /** 界面新增：记为 user、pinned */
  create(input: MemoryCreateInput): Promise<IpcResult<{ memory: MemoryView }>>;
  update(input: MemoryUpdateInput): Promise<IpcResult<{ memory: MemoryView }>>;
  remove(input: MemoryRemoveInput): Promise<IpcResult>;
  /** 清空工作区所属项目（共用该项目的工作区一并清空） */
  clear(workspaceId: string): Promise<IpcResult<{ removed: number }>>;
  /** 任一写入路径之后触发，带受影响的工作区 */
  onChanged(listener: (payload: { workspaceIds: string[] }) => void): Unsubscribe;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };

export function createMemoryApi(
  ipc: Invoker,
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => Unsubscribe
): MemoryApi {
  return {
    list: (workspaceId) => ipc.invoke(IPC_CHANNELS.MEMORY_LIST, { workspaceId }),
    create: (input) => ipc.invoke(IPC_CHANNELS.MEMORY_CREATE, input),
    update: (input) => ipc.invoke(IPC_CHANNELS.MEMORY_UPDATE, input),
    remove: (input) => ipc.invoke(IPC_CHANNELS.MEMORY_REMOVE, input),
    clear: (workspaceId) => ipc.invoke(IPC_CHANNELS.MEMORY_CLEAR, { workspaceId }),
    onChanged: (listener) =>
      subscribe(IPC_CHANNELS.MEMORY_CHANGED, (payload) => {
        const ids = (payload as { workspaceIds?: unknown } | undefined)?.workspaceIds;
        listener({
          workspaceIds: Array.isArray(ids)
            ? ids.filter((id): id is string => typeof id === 'string')
            : [],
        });
      }),
  };
}
