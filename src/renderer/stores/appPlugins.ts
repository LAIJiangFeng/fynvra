import { errorMessage } from '@shared/guards';
import type { AppPluginView } from '@shared/types/appPlugins';
import { create } from 'zustand';
import type {
  AppPluginActionResult,
  AppPluginRemoveResult,
} from '../../preload/domains/appPlugins';
import { usePluginsStore } from './plugins';

/** Fynvra 插件（后台进程）的列表与操作；Renderer 只传 id */
export interface AppPluginsState {
  plugins: AppPluginView[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  toggle(id: string, enabled: boolean): Promise<AppPluginActionResult>;
  remove(id: string): Promise<AppPluginRemoveResult>;
  update(id: string): Promise<AppPluginActionResult>;
  recopy(id: string): Promise<AppPluginActionResult>;
  addLocalDev(): Promise<AppPluginActionResult>;
}

const api = window.fynvra.appPlugins;
/** 只认最后一次读取的结果 */
let listSeq = 0;

async function safeAction<T>(
  call: () => Promise<T>
): Promise<T | { ok: false; code: 'failed'; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, code: 'failed', error: errorMessage(error) };
  }
}

// 成功后 Main 广播 appplugins:changed，下面的订阅会刷新列表
export const useAppPluginsStore = create<AppPluginsState>()((set) => ({
  plugins: [],
  loaded: false,
  error: null,

  async refresh() {
    const mine = ++listSeq;
    try {
      const result = await api.list();
      if (mine !== listSeq) return;
      set(
        result.ok
          ? { plugins: result.plugins, loaded: true, error: null }
          : { loaded: true, error: result.error }
      );
    } catch (error) {
      if (mine === listSeq) set({ loaded: true, error: errorMessage(error) });
    }
  },
  toggle: (id, enabled) => safeAction(() => api.toggle({ id, enabled })),
  remove: (id) => safeAction(() => api.remove({ id })),
  update: (id) => safeAction(() => api.update({ id })),
  recopy: (id) => safeAction(() => api.recopy({ id })),
  addLocalDev: () => safeAction(() => api.addLocalDev()),
}));

api.onChanged(() => {
  void useAppPluginsStore.getState().refresh();
  // 市场卡片上的「已安装」也取决于 Fynvra 插件登记
  const plugins = usePluginsStore.getState();
  if (plugins.market) void plugins.loadMarket();
});
void useAppPluginsStore.getState().refresh();
