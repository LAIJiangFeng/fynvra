import { type Preferences, type PreferencesResult, sidebarOpenOf } from '@shared/types/settings';
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

  it('界面语言：没写过时不落盘这个字段；切换后连同主题一起写入，重新水合读回', async () => {
    let disk: PreferencesResult = {
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true },
    };
    const { api, update } = bridge(async () => disk);
    const store = createSettingsStore(api);
    await settle();
    expect(store.getState().language).toBeUndefined();

    store.getState().toggleSidePanel();
    await settle();
    expect(update).toHaveBeenLastCalledWith({ theme: 'system', sidePanelOpen: false });

    store.getState().setLanguage('en');
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      theme: 'system',
      sidePanelOpen: false,
      language: 'en',
    });

    disk = { ok: true, preferences: { theme: 'system', sidePanelOpen: true, language: 'zh-CN' } };
    await store.persist.rehydrate();
    expect(store.getState().language).toBe('zh-CN');
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

describe('左栏开合（sidebarOpen）', () => {
  it('首次水合前的切换不落盘；水合后切换连同其他偏好一起写入', async () => {
    const pending = deferred<PreferencesResult>();
    const { api, update } = bridge(() => pending.promise);
    const store = createSettingsStore(api);

    store.getState().toggleSidebar();
    await settle();
    expect(update).not.toHaveBeenCalled();

    pending.resolve({
      ok: true,
      preferences: { theme: 'light', sidePanelOpen: false, sidebarOpen: false },
    });
    await settle();
    expect(sidebarOpenOf(store.getState())).toBe(false);
    expect(update).not.toHaveBeenCalled();

    store.getState().toggleSidebar();
    await settle();
    expect(sidebarOpenOf(store.getState())).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({
      theme: 'light',
      sidePanelOpen: false,
      sidebarOpen: true,
    });
  });

  it('读取失败时一直关闸：切换只在内存里生效', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, update } = bridge(async () => ({ ok: false, error: 'settings.json 不可读' }));
    const store = createSettingsStore(api);
    await settle();

    store.getState().toggleSidebar();
    await settle();
    expect(sidebarOpenOf(store.getState())).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('没切换过时按展开、不写这个字段；切换后落盘，重新水合读回', async () => {
    let disk: PreferencesResult = {
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true },
    };
    const { api, update } = bridge(async () => disk);
    const store = createSettingsStore(api);
    await settle();
    expect(store.getState().sidebarOpen).toBeUndefined();
    expect(sidebarOpenOf(store.getState())).toBe(true);

    store.getState().toggleSidePanel();
    await settle();
    expect(update).toHaveBeenLastCalledWith({ theme: 'system', sidePanelOpen: false });

    store.getState().toggleSidebar();
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      theme: 'system',
      sidePanelOpen: false,
      sidebarOpen: false,
    });

    // 展开也要写：Main 按字段合并，不写的话磁盘上还是收起
    store.getState().toggleSidebar();
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      theme: 'system',
      sidePanelOpen: false,
      sidebarOpen: true,
    });

    // 重启（或其他窗口改过）：按磁盘上的值
    disk = { ok: true, preferences: { theme: 'system', sidePanelOpen: true, sidebarOpen: false } };
    await store.persist.rehydrate();
    expect(sidebarOpenOf(store.getState())).toBe(false);
  });

  it('磁盘上的非法值按展开', async () => {
    const corrupted = { theme: 'dark', sidePanelOpen: true, sidebarOpen: 'no' };
    const store = createSettingsStore(
      bridge(async () => ({ ok: true, preferences: corrupted as unknown as Preferences })).api
    );
    await settle();
    expect(store.getState().sidebarOpen).toBeUndefined();
    expect(sidebarOpenOf(store.getState())).toBe(true);
  });

  it('openSidebar：收起时展开并落盘；已经展开时什么都不写', async () => {
    const { api, update } = bridge(async () => ({
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true, sidebarOpen: false },
    }));
    const store = createSettingsStore(api);
    await settle();

    store.getState().openSidebar();
    await settle();
    expect(sidebarOpenOf(store.getState())).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({
      theme: 'system',
      sidePanelOpen: true,
      sidebarOpen: true,
    });

    store.getState().openSidebar();
    await settle();
    expect(update).toHaveBeenCalledTimes(1);

    // 没切换过（按展开）也不写
    const fresh = bridge(async () => ({
      ok: true,
      preferences: { theme: 'system', sidePanelOpen: true },
    }));
    const untouched = createSettingsStore(fresh.api);
    await settle();
    untouched.getState().openSidebar();
    await settle();
    expect(fresh.update).not.toHaveBeenCalled();
  });
});
