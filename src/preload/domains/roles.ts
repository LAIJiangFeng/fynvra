import type { Role } from '@fynvra/core';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';

export type RoleListResult = IpcResult<{ roles: Role[] }>;
export type RoleResult = IpcResult<{ role: Role }>;

export interface RolesApi {
  /** 内置角色在前（builtin: true，可配置），自定义角色按 id 排序 */
  list(): Promise<RoleListResult>;
  get(id: string): Promise<RoleResult>;
  /** 保存角色配置：Main 经 parseRole 校验后写 userData/roles/<id>.json，内置身份按 id 判定 */
  save(role: Role): Promise<RoleResult>;
  /** 删除自定义角色；内置角色拒绝 */
  remove(id: string): Promise<IpcResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createRolesApi(ipc: Invoker, subscribe: Subscribe): RolesApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.ROLES_LIST),
    get: (id) => ipc.invoke(IPC_CHANNELS.ROLES_GET, id),
    save: (role) => ipc.invoke(IPC_CHANNELS.ROLES_SAVE, role),
    remove: (id) => ipc.invoke(IPC_CHANNELS.ROLES_REMOVE, id),
    onChanged: (callback) => subscribe(IPC_CHANNELS.ROLES_CHANGED, () => callback()),
  };
}
