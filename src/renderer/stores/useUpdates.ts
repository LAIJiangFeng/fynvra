import { createUpdatesStore } from './updates';

export const useUpdatesStore = createUpdatesStore({
  state: () => window.fynvra.updates.state(),
  check: () => window.fynvra.updates.check(),
  install: () => window.fynvra.updates.install(),
  onChanged: (callback) => window.fynvra.updates.onChanged(callback),
});
