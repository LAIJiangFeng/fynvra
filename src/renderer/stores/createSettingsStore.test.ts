import type { Preferences, PreferencesResult } from '@shared/types/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type PreferencesBridge } from './createSettingsStore';

function bridge(read: () => Promise<PreferencesResult>) {
  const update = vi.fn(
    async (patch: Partial<Preferences>): Promise<PreferencesResult> => ({
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true, ...patch },
    })
  );
  const api: PreferencesBridge = { get: vi.fn(read), update };
  return { api, update };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 等 persist 的水合链（多个 microtask）走完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSettingsStore', () => {
  it('首次水合前的修改不落盘；水合后带着磁盘状态继续写', async () => {
    const pending = deferred<PreferencesResult>();
    const { api, update } = bridge(() => pending.promise);
    const store = createSettingsStore(api);

    // Main 回包还没到：这一笔若落盘，会用「默认值 + dark」覆盖磁盘
    store.getState().setTheme('dark');
    await settle();
    expect(update).not.toHaveBeenCalled();

    pending.resolve({ ok: true, preferences: { theme: 'light', sidePanelOpen: false } });
    await settle();
    expect(store.getState()).toMatchObject({ theme: 'light', sidePanelOpen: false });
    expect(update).not.toHaveBeenCalled();

    store.getState().setTheme('dark');
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({ theme: 'dark', sidePanelOpen: false });
  });

  it('读取失败时一直关闸，不会用默认值覆盖磁盘', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, update } = bridge(async () => ({ ok: false, error: 'settings.json 不可读' }));
    const store = createSettingsStore(api);
    await settle();

    store.getState().toggleSidePanel();
    await settle();
    expect(store.getState().sidePanelOpen).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('重新水合拿到其他窗口写入的值', async () => {
    let disk: PreferencesResult = {
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true },
    };
    const store = createSettingsStore(bridge(async () => disk).api);
    await settle();

    disk = { ok: true, preferences: { theme: 'dark', sidePanelOpen: true } };
    await store.persist.rehydrate();
    expect(store.getState().theme).toBe('dark');
  });

  it('合并时收窄非法值，动作函数保留', async () => {
    const corrupted = { theme: 'neon', sidePanelOpen: 'yes' } as unknown as Preferences;
    const store = createSettingsStore(
      bridge(async () => ({ ok: true, preferences: corrupted })).api
    );
    await settle();
    expect(store.getState()).toMatchObject({ theme: 'system', sidePanelOpen: true });
    expect(store.getState().setTheme).toBeTypeOf('function');
  });
});
