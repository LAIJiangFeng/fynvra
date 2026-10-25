import type { Role } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import { create } from 'zustand';
import type { RoleResult } from '../../preload/domains/roles';

export interface RolesState {
  /** 内置角色在前（builtin: true，可配置），自定义角色按 id 排序 */
  roles: Role[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** 新建或覆盖角色配置，落盘到 userData/roles/<id>.json */
  save(role: Role): Promise<RoleResult>;
  remove(id: string): Promise<IpcResult>;
}

const api = window.fynvra.roles;

async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const useRolesStore = create<RolesState>()((set, get) => ({
  roles: [],
  loaded: false,
  error: null,

  async refresh() {
    const result = await safely(() => api.list());
    set(
      result.ok
        ? { roles: result.roles, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
  },

  async save(role) {
    const result = await safely(() => api.save(role));
    if (result.ok) await get().refresh();
    return result;
  },

  async remove(id) {
    const result = await safely(() => api.remove(id));
    if (result.ok) await get().refresh();
    return result;
  },
}));

api.onChanged(() => {
  void useRolesStore.getState().refresh();
});
void useRolesStore.getState().refresh();
