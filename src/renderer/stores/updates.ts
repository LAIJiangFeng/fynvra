import { errorMessage } from '@shared/guards';
import type { UpdateResult, UpdateState } from '@shared/types/updates';
import { create } from 'zustand';
import type { UpdatesApi } from '../../preload/domains/updates';

interface UpdatesState {
  state: UpdateState | null;
  error: string | null;
  busy: boolean;
  bind(): () => void;
  check(): Promise<void>;
  install(): Promise<void>;
}

export function createUpdatesStore(api: UpdatesApi) {
  return create<UpdatesState>()((set, get) => {
    const accept = (state: UpdateState) => {
      if (state.seq < (get().state?.seq ?? -1)) return;
      set({ state, error: null });
    };
    const acceptResult = (result: UpdateResult) => {
      if (result.ok) accept(result.state);
      else set({ error: result.error });
    };
    const run = async (action: () => Promise<UpdateResult>) => {
      if (get().busy) return;
      set({ busy: true, error: null });
      try {
        acceptResult(await action());
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ busy: false });
      }
    };
    return {
      state: null,
      error: null,
      busy: false,
      bind() {
        let active = true;
        const unsubscribe = api.onChanged((state) => {
          if (active) accept(state);
        });
        void api
          .state()
          .then((result) => {
            if (active) acceptResult(result);
          })
          .catch((error: unknown) => {
            if (active) set({ error: errorMessage(error) });
          });
        return () => {
          active = false;
          unsubscribe();
        };
      },
      check: () => run(() => api.check()),
      install: () => run(() => api.install()),
    };
  });
}
