import { DEFAULT_NETWORK_PROXY, type NetworkTestResult } from '@shared/networkProxy';
import { DEFAULT_PREFERENCES } from '@shared/types/settings';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsApi } from '../../preload/types';
import { createNetworkProxyStore } from './createNetworkProxyStore';

const config = { mode: 'manual' as const, url: 'http://127.0.0.1:7890', gitCompatibility: true };
const success = {
  ok: true as const,
  api: { status: 'ok' as const },
  git: { status: 'ok' as const },
};
function setup() {
  let changed = () => {};
  const pending: ((result: { ok: true } & NetworkTestResult) => void)[] = [];
  const api = {
    get: vi.fn<SettingsApi['get']>(async () => ({
      ok: true as const,
      preferences: { ...DEFAULT_PREFERENCES },
    })),
    update: vi.fn<SettingsApi['update']>(async (patch) => ({
      ok: true,
      preferences: { ...DEFAULT_PREFERENCES, ...patch },
    })),
    testNetwork: vi.fn<SettingsApi['testNetwork']>(
      () => new Promise((resolve) => pending.push(resolve))
    ),
    cancelNetworkTest: vi.fn(async () => ({ ok: true as const })),
    onChanged: (callback: () => void) => {
      changed = callback;
      return () => {};
    },
  };
  const store = createNetworkProxyStore(api);
  return { api, store, pending, changed: () => changed() };
}

describe('network settings draft lifecycle', () => {
  it('saves and clears through settings; tests the normalized unsaved draft', async () => {
    const { store, api, pending } = setup();
    const disconnect = store.getState().connect();
    await Promise.resolve();
    store.getState().edit(config);
    const test = store.getState().test();
    expect(api.testNetwork).toHaveBeenCalledWith(config);
    expect(api.update).not.toHaveBeenCalled();
    pending[0]?.(success);
    await test;
    expect(store.getState().result).toEqual({ api: success.api, git: success.git });
    await store.getState().save();
    expect(api.update).toHaveBeenLastCalledWith({ networkProxy: config });
    await store.getState().save(true);
    expect(api.update).toHaveBeenLastCalledWith({ networkProxy: undefined });
    expect(store.getState().draft).toEqual(DEFAULT_NETWORK_PROXY);
    disconnect();
  });
  it.each(['edit', 'cancel', 'external', 'unmount'] as const)(
    'discards a late result after %s',
    async (action) => {
      const { store, api, pending, changed } = setup();
      const disconnect = store.getState().connect();
      await Promise.resolve();
      store.getState().edit(config);
      const test = store.getState().test();
      if (action === 'edit') store.getState().edit({ ...config, gitCompatibility: false });
      if (action === 'cancel') store.getState().cancel();
      if (action === 'external') changed();
      if (action === 'unmount') disconnect();
      pending[0]?.(success);
      await test;
      expect(store.getState().result).toBeNull();
      expect(store.getState().testing).toBe(false);
      expect(api.cancelNetworkTest).toHaveBeenCalled();
      if (action !== 'unmount') disconnect();
    }
  );
  it('invalidates a test started while an external settings reload is still pending', async () => {
    const { store, api, pending, changed } = setup();
    const disconnect = store.getState().connect();
    await Promise.resolve();
    let resolveLoad: (value: Awaited<ReturnType<typeof api.get>>) => void = () => {};
    api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    );
    changed();
    const test = store.getState().test();
    resolveLoad({ ok: true, preferences: { ...DEFAULT_PREFERENCES, networkProxy: config } });
    await Promise.resolve();
    pending[0]?.(success);
    await test;
    expect(store.getState().draft).toEqual(config);
    expect(store.getState().result).toBeNull();
    expect(api.cancelNetworkTest).toHaveBeenCalled();
    disconnect();
  });
  it('old responses cannot overwrite a newer test, and invalid input never reaches IPC', async () => {
    const { store, api, pending } = setup();
    store.getState().edit(config);
    const first = store.getState().test();
    const second = store.getState().test();
    pending[1]?.(success);
    await second;
    pending[0]?.({ ok: true, api: { status: 'failed' }, git: { status: 'failed' } });
    await first;
    expect(store.getState().result?.api.status).toBe('ok');
    store.getState().edit({ ...config, url: 'http://user:secret@proxy' });
    await store.getState().test();
    await store.getState().save();
    expect(api.testNetwork).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
    expect(store.getState().error).toBe('invalid');
  });
});
