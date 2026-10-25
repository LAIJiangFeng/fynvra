import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type PreferencesResult,
} from '@shared/types/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreferencesBridge } from '../../stores/createSettingsStore';
import { createKeybindingsStore } from './store';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 假的 Main：持有磁盘上的 preferences，update 按 settings:update 的语义合并 */
function fakeMain(initial: Partial<Preferences> = {}) {
  let disk: Preferences = { ...DEFAULT_PREFERENCES, ...initial };
  const get = vi.fn(async (): Promise<PreferencesResult> => ({ ok: true, preferences: disk }));
  const update = vi.fn(async (patch: Partial<Preferences>): Promise<PreferencesResult> => {
    const { keybindings, ...rest } = { ...disk, ...patch };
    disk = {
      ...rest,
      ...(keybindings && Object.keys(keybindings).length > 0 ? { keybindings } : {}),
    };
    return { ok: true, preferences: disk };
  });
  const api: PreferencesBridge = { get, update };
  return { api, get, update, disk: () => disk };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKeybindingsStore', () => {
  it('读到磁盘上的覆盖表之前用默认键；读到后按平台展开', async () => {
    const main = fakeMain({ keybindings: { 'new-session': 'mod+alt+n' } });
    const store = createKeybindingsStore(main.api, 'windows');
    expect(store.getState().bindings['new-session']).toBe('ctrl+n');
    expect(store.getState().loaded).toBe(false);

    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().overrides).toEqual({ 'new-session': 'mod+alt+n' });
    expect(store.getState().bindings['new-session']).toBe('ctrl+alt+n');

    const mac = createKeybindingsStore(main.api, 'mac');
    await mac.getState().load();
    expect(mac.getState().bindings['new-session']).toBe('alt+meta+n');
  });

  it('改键立即生效，并把整张覆盖表写给 Main', async () => {
    const main = fakeMain({ keybindings: { 'open-settings': 'ctrl+alt+s' } });
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    const saving = store.getState().setChord('new-session', 'ctrl+shift+n');
    expect(store.getState().bindings['new-session']).toBe('ctrl+shift+n');
    await saving;
    expect(main.update).toHaveBeenLastCalledWith({
      keybindings: { 'open-settings': 'ctrl+alt+s', 'new-session': 'ctrl+shift+n' },
    });
    expect(main.disk().keybindings).toEqual({
      'open-settings': 'ctrl+alt+s',
      'new-session': 'ctrl+shift+n',
    });
  });

  it('改回默认键等于重置：覆盖表里去掉这一项', async () => {
    const main = fakeMain({ keybindings: { 'new-session': 'ctrl+shift+n' } });
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    await store.getState().setChord('new-session', 'ctrl+n');
    expect(store.getState().overrides).toEqual({});
    expect(main.update).toHaveBeenLastCalledWith({ keybindings: {} });
    expect(main.disk()).not.toHaveProperty('keybindings');
  });

  it('重置一项、全部重置', async () => {
    const main = fakeMain({
      keybindings: { 'new-session': 'ctrl+shift+n', send: 'ctrl+enter' },
    });
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    await store.getState().reset('send');
    expect(store.getState().overrides).toEqual({ 'new-session': 'ctrl+shift+n' });
    expect(store.getState().bindings.send).toBe('enter');

    await store.getState().resetAll();
    expect(store.getState().overrides).toEqual({});
    expect(store.getState().bindings['new-session']).toBe('ctrl+n');
    expect(main.disk()).not.toHaveProperty('keybindings');
  });

  it('还没读到磁盘时改键：先读，再在磁盘的覆盖表上改，不会用空表盖掉', async () => {
    const main = fakeMain({ keybindings: { 'open-settings': 'ctrl+alt+s' } });
    const store = createKeybindingsStore(main.api, 'windows');

    await store.getState().setChord('send', 'ctrl+enter');
    expect(main.get).toHaveBeenCalled();
    expect(main.update).toHaveBeenCalledTimes(1);
    expect(main.update).toHaveBeenLastCalledWith({
      keybindings: { 'open-settings': 'ctrl+alt+s', send: 'ctrl+enter' },
    });
  });

  it('读取失败时不写，保持默认键', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = fakeMain();
    main.get.mockResolvedValue({ ok: false, error: 'settings.json 不可读' });
    const store = createKeybindingsStore(main.api, 'windows');

    await store.getState().setChord('send', 'ctrl+enter');
    expect(main.update).not.toHaveBeenCalled();
    expect(store.getState().bindings.send).toBe('enter');
    expect(error).toHaveBeenCalled();
  });

  it('写入失败（含 IPC 抛异常）：按 Main 的记录恢复', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = fakeMain({ keybindings: { 'new-session': 'ctrl+shift+n' } });
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    main.update.mockResolvedValueOnce({ ok: false, error: '无效的设置项' });
    await store.getState().setChord('send', 'ctrl+enter');
    expect(store.getState().overrides).toEqual({ 'new-session': 'ctrl+shift+n' });
    expect(store.getState().bindings.send).toBe('enter');

    main.update.mockRejectedValueOnce(new Error('IPC 断开'));
    await store.getState().reset('new-session');
    expect(store.getState().bindings['new-session']).toBe('ctrl+shift+n');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('连着改两次：先发的回包晚到也不会盖掉后一次', async () => {
    const main = fakeMain();
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    const first = deferred<PreferencesResult>();
    main.update.mockImplementationOnce(() => first.promise);
    const firstSave = store.getState().setChord('send', 'ctrl+enter');
    const secondSave = store.getState().setChord('newline', 'alt+enter');
    await secondSave;
    first.resolve({
      ok: true,
      preferences: { ...DEFAULT_PREFERENCES, keybindings: { send: 'ctrl+enter' } },
    });
    await firstSave;
    expect(store.getState().overrides).toEqual({ send: 'ctrl+enter', newline: 'alt+enter' });
    expect(store.getState().bindings.newline).toBe('alt+enter');
  });

  it('重读（其他窗口改过）拿到磁盘上的最新覆盖表；在途的旧读取晚到时丢弃', async () => {
    const main = fakeMain();
    const store = createKeybindingsStore(main.api, 'windows');
    await store.getState().load();

    const stale = deferred<PreferencesResult>();
    main.get.mockImplementationOnce(() => stale.promise);
    const staleLoad = store.getState().load();
    await main.api.update({ keybindings: { 'search-sessions': 'ctrl+shift+f' } });
    await store.getState().load();
    expect(store.getState().bindings['search-sessions']).toBe('ctrl+shift+f');

    stale.resolve({ ok: true, preferences: { ...DEFAULT_PREFERENCES } });
    await staleLoad;
    expect(store.getState().bindings['search-sessions']).toBe('ctrl+shift+f');
  });
});
