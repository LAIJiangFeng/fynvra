import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { PluginEntry, PluginProviderMap } from '@shared/types/plugins';
import { create } from 'zustand';
import type {
  PluginActionResult,
  PluginAddResult,
  PluginImportResult,
  PluginOpenAsWorkspaceResult,
  PluginRemoveResult,
  PluginScanImportsResult,
  PluginSetManualProvidersResult,
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
  /** Main 弹框选择目录或扩展文件，一律复制一份；不传路径 */
  addLocal(): Promise<PluginAddResult>;
  install(source: string): Promise<PluginAddResult>;
  /** 只读扫描原生 pi 的扩展与包 */
  scanImports(): Promise<PluginScanImportsResult>;
  /** 导入扫描到的候选；只传 id */
  importCandidates(ids: string[]): Promise<PluginImportResult>;
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
  /** 整组替换手动添加的服务名 */
  setManualProviders(id: string, names: string[]): Promise<PluginSetManualProvidersResult>;
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

  async addLocal() {
    let result: PluginAddResult;
    try {
      result = await api.addLocal();
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

  scanImports: () => safely(() => api.scanImports()),

  async importCandidates(ids) {
    const result = await safely(() => api.importCandidates({ ids }));
    if (result.ok && result.imported.length > 0) await get().refresh();
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

  async setManualProviders(id, names) {
    const result = await safely(() => api.setManualProviders({ id, names }));
    if (result.ok) {
      const plugin = result.plugin;
      set({ plugins: get().plugins.map((entry) => (entry.id === plugin.id ? plugin : entry)) });
    }
    return result;
  },
}));

api.onChanged(() => {
  void usePluginsStore.getState().refresh();
});
void usePluginsStore.getState().refresh();
