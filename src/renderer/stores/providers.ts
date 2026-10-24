import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type { ModelProviderView } from '@shared/types/llm';
import { create } from 'zustand';
import type {
  ProviderSaveResult,
  ProviderTestResult,
  ProviderUpsertInput,
} from '../../preload/domains/providers';

export interface ProvidersState {
  /** 已脱敏：只有 hasApiKey 与末 4 位 */
  providers: ModelProviderView[];
  loaded: boolean;
  /** 最近一次读取失败的原因 */
  error: string | null;
  refresh(): Promise<void>;
  upsert(input: ProviderUpsertInput): Promise<ProviderSaveResult>;
  remove(id: string): Promise<IpcResult>;
  test(id: string): Promise<ProviderTestResult>;
}

const api = window.fynvra.providers;

/** IPC 调用本身失败（极少见）也折成 { ok: false }，组件只处理一种形状。 */
async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const useProvidersStore = create<ProvidersState>()((set, get) => ({
  providers: [],
  loaded: false,
  error: null,

  async refresh() {
    const result = await safely(() => api.list());
    set(
      result.ok
        ? { providers: result.providers, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
  },

  async upsert(input) {
    const result = await safely(() => api.upsert(input));
    if (result.ok) await get().refresh();
    return result;
  },

  async remove(id) {
    const result = await safely(() => api.remove(id));
    if (result.ok) await get().refresh();
    return result;
  },

  test: (id) => safely(() => api.test(id)),
}));

// 其他窗口或 Main 改了列表：重读
api.onChanged(() => {
  void useProvidersStore.getState().refresh();
});
void useProvidersStore.getState().refresh();
