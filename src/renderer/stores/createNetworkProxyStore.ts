import {
  DEFAULT_NETWORK_PROXY,
  type NetworkProxy,
  type NetworkTestResult,
  parseNetworkProxy,
} from '@shared/networkProxy';
import { create } from 'zustand';
import type { SettingsApi } from '../../preload/types';

type ProxyApi = Pick<
  SettingsApi,
  'get' | 'update' | 'testNetwork' | 'cancelNetworkTest' | 'onChanged'
>;
interface NetworkProxyState {
  draft: NetworkProxy;
  loaded: boolean;
  saving: boolean;
  testing: boolean;
  saved: boolean;
  result: NetworkTestResult | null;
  error: 'load' | 'save' | 'test' | 'invalid' | null;
  connect(): () => void;
  edit(draft: NetworkProxy): void;
  save(reset?: boolean): Promise<void>;
  test(): Promise<void>;
  cancel(): void;
}

/** Epochs cover edits, external settings changes, cancel, unmount and replaced requests. */
export function createNetworkProxyStore(api: ProxyApi) {
  let epoch = 0;
  let loadEpoch = 0;
  let lastSaved: NetworkProxy = DEFAULT_NETWORK_PROXY;
  const equal = (a: NetworkProxy, b: NetworkProxy) => JSON.stringify(a) === JSON.stringify(b);
  const cancelRemote = () => {
    void api.cancelNetworkTest().catch(() => {});
  };
  return create<NetworkProxyState>((set, get) => {
    const invalidate = () => {
      epoch++;
      if (get().testing) cancelRemote();
      set({ testing: false, result: null });
    };
    const load = async () => {
      const request = ++loadEpoch;
      try {
        const response = await api.get();
        if (request !== loadEpoch) return;
        if (!response.ok) {
          set({ error: 'load' });
          return;
        }
        const next = response.preferences.networkProxy ?? DEFAULT_NETWORK_PROXY;
        const clean = !get().loaded || equal(get().draft, lastSaved);
        if (clean && !equal(get().draft, next)) invalidate();
        lastSaved = next;
        set({ loaded: true, ...(clean ? { draft: next } : {}) });
      } catch {
        if (request === loadEpoch) set({ error: 'load' });
      }
    };
    return {
      draft: DEFAULT_NETWORK_PROXY,
      loaded: false,
      saving: false,
      testing: false,
      saved: false,
      result: null,
      error: null,
      connect: () => {
        const unsubscribe = api.onChanged(() => {
          invalidate();
          void load();
        });
        void load();
        return () => {
          loadEpoch++;
          invalidate();
          unsubscribe();
        };
      },
      edit: (draft) => {
        invalidate();
        set({ draft, saved: false, error: null });
      },
      cancel: invalidate,
      save: async (reset = false) => {
        if (get().saving) return;
        const config = reset ? undefined : parseNetworkProxy(get().draft);
        if (config === null) {
          set({ error: 'invalid' });
          return;
        }
        invalidate();
        set({ saving: true, saved: false, error: null });
        try {
          const response = await api.update({ networkProxy: config });
          if (!response.ok) {
            set({ error: 'save' });
            return;
          }
          lastSaved = response.preferences.networkProxy ?? DEFAULT_NETWORK_PROXY;
          set({ draft: lastSaved, saved: true });
        } catch {
          set({ error: 'save' });
        } finally {
          set({ saving: false });
        }
      },
      test: async () => {
        const config = parseNetworkProxy(get().draft);
        if (!config) {
          set({ error: 'invalid' });
          return;
        }
        invalidate();
        const request = epoch;
        set({ testing: true, error: null, saved: false });
        try {
          const response = await api.testNetwork(config);
          if (request !== epoch) return;
          set(
            response.ok ? { result: { api: response.api, git: response.git } } : { error: 'test' }
          );
        } catch {
          if (request === epoch) set({ error: 'test' });
        } finally {
          if (request === epoch) set({ testing: false });
        }
      },
    };
  });
}
