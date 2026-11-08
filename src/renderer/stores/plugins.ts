import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { PluginEntry, PluginMode, PluginProviderMap } from '@shared/types/plugins';
import { create } from 'zustand';
import type {
  PluginActionResult,
  PluginAddResult,
  PluginOpenAsWorkspaceResult,
  PluginRemoveResult,
  PluginSetProviderMappingResult,
  PluginToggleResult,
} from '../../preload/domains/plugins';

export interface PluginsState {
  plugins: PluginEntry[];
  /** 插件里的服务名 → 服务 id（全局）；没有条目的名字为「自动（同名）」 */
  providerMap: PluginProviderMap;
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Main 弹框选择目录或扩展文件；copy 复制一份，link 引用原文件；不传路径 */
  addLocal(mode: PluginMode): Promise<PluginAddResult>;
  install(source: string): Promise<PluginAddResult>;
  remove(id: string): Promise<PluginRemoveResult>;
  toggle(id: string, enabled: boolean): Promise<PluginToggleResult>;
  reveal(id: string): Promise<IpcResult>;
  openIn(id: string, appId: string): Promise<IpcResult>;
  openAsWorkspace(id: string): Promise<PluginOpenAsWorkspaceResult>;
  recopy(id: string): Promise<PluginActionResult>;
  convertToCopy(id: string): Promise<PluginActionResult>;
  /** serviceId 为 null 恢复「自动（同名）」 */
  setProviderMapping(
    name: string,
    serviceId: string | null
  ): Promise<PluginSetProviderMappingResult>;
}

/** IPC 调用本身失败（极少见）也折成 { ok: false } */
async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function safeAction(call: () => Promise<PluginActionResult>): Promise<PluginActionResult> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, code: 'failed', error: errorMessage(error) };
  }
}

const api = window.fynvra.plugins;

export const usePluginsStore = create<PluginsState>()((set, get) => ({
  plugins: [],
  providerMap: {},
  loaded: false,
  error: null,

  async refresh() {
    try {
      const result = await api.list();
      set(
        result.ok
          ? {
              plugins: result.plugins,
              providerMap: result.providerMap ?? {},
              loaded: true,
              error: null,
            }
          : { loaded: true, error: result.error }
      );
    } catch (error) {
      set({ loaded: true, error: errorMessage(error) });
    }
  },

  async addLocal(mode) {
    let result: PluginAddResult;
    try {
      result = await api.addLocal({ mode });
    } catch (error) {
      result = { ok: false, code: 'failed', error: errorMessage(error) };
    }
    if (result.ok) await get().refresh();
    return result;
  },

  async install(source) {
    let result: PluginAddResult;
    try {
      result = await api.install({ source });
    } catch (error) {
      result = { ok: false, code: 'failed', error: errorMessage(error) };
    }
    if (result.ok) await get().refresh();
    return result;
  },

  async remove(id) {
    let result: PluginRemoveResult;
    try {
      result = await api.remove(id);
    } catch (error) {
      result = { ok: false, code: 'failed', error: errorMessage(error) };
    }
    if (result.ok) await get().refresh();
    return result;
  },

  async toggle(id, enabled) {
    let result: PluginToggleResult;
    try {
      result = await api.toggle({ id, enabled });
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    if (result.ok) await get().refresh();
    return result;
  },

  reveal: (id) => safely(() => api.reveal(id)),
  openIn: (id, appId) => safely(() => api.openIn({ id, appId })),
  openAsWorkspace: (id) => safely(() => api.openAsWorkspace(id)),

  async recopy(id) {
    const result = await safeAction(() => api.recopy(id));
    if (result.ok) await get().refresh();
    return result;
  },

  async convertToCopy(id) {
    const result = await safeAction(() => api.convertToCopy(id));
    if (result.ok) await get().refresh();
    return result;
  },

  async setProviderMapping(name, serviceId) {
    const result = await safely(() => api.setProviderMapping({ name, serviceId }));
    if (result.ok) set({ providerMap: result.providerMap });
    return result;
  },
}));

api.onChanged(() => {
  void usePluginsStore.getState().refresh();
});
void usePluginsStore.getState().refresh();
