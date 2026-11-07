import { errorMessage } from '@shared/guards';
import type { PluginEntry } from '@shared/types/plugins';
import { create } from 'zustand';
import type {
  PluginAddResult,
  PluginRemoveResult,
  PluginToggleResult,
} from '../../preload/domains/plugins';

export interface PluginsState {
  plugins: PluginEntry[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Main 弹框选择目录或扩展文件；不传路径 */
  addLocal(): Promise<PluginAddResult>;
  install(source: string): Promise<PluginAddResult>;
  remove(id: string): Promise<PluginRemoveResult>;
  toggle(id: string, enabled: boolean): Promise<PluginToggleResult>;
}

const api = window.fynvra.plugins;

export const usePluginsStore = create<PluginsState>()((set, get) => ({
  plugins: [],
  loaded: false,
  error: null,

  async refresh() {
    try {
      const result = await api.list();
      set(
        result.ok
          ? { plugins: result.plugins, loaded: true, error: null }
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
}));

api.onChanged(() => {
  void usePluginsStore.getState().refresh();
});
void usePluginsStore.getState().refresh();
