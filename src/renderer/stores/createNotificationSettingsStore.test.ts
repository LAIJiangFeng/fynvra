import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type Preferences,
  type PreferencesResult,
} from '@shared/types/settings';
import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationSettingsStore,
  type NotificationSettingsApi,
} from './createNotificationSettingsStore';

const BASE: Preferences = { theme: 'system', sidePanelOpen: true };
const withNotifications = (patch: Partial<NotificationPreferences>): Preferences => ({
  ...BASE,
  notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...patch },
});

/** 手动结算的回包，测乱序 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeApi(preferences: Preferences = BASE) {
  return {
    settings: {
      get: vi.fn(async (): Promise<PreferencesResult> => ({ ok: true, preferences })),
      update: vi.fn(
        async (patch: Partial<Preferences>): Promise<PreferencesResult> => ({
          ok: true,
          preferences: { ...preferences, ...patch },
        })
      ),
    },
    notifications: { test: vi.fn(async () => ({ ok: true as const })) },
  } satisfies NotificationSettingsApi;
}

describe('createNotificationSettingsStore', () => {
  it('refresh：settings.json 里没有这一块时是默认值，有就用它；读不到时记错误', async () => {
    const empty = createNotificationSettingsStore(fakeApi());
    expect(empty.getState().preferences).toBeNull();
    await empty.getState().refresh();
    expect(empty.getState().preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);

    const custom = createNotificationSettingsStore(fakeApi(withNotifications({ sound: false })));
    await custom.getState().refresh();
    expect(custom.getState().preferences).toMatchObject({ sound: false, enabled: true });

    const api = fakeApi();
    api.settings.get.mockResolvedValueOnce({ ok: false, error: '读不到' });
    const failing = createNotificationSettingsStore(api);
    await failing.getState().refresh();
    expect(failing.getState()).toMatchObject({ preferences: null, error: '读不到' });
  });

  it('update：先在界面上换上，整块发给 Main，回包后以 Main 为准', async () => {
    const api = fakeApi();
    const store = createNotificationSettingsStore(api);
    await store.getState().refresh();

    const pending = deferred<PreferencesResult>();
    api.settings.update.mockReturnValueOnce(pending.promise);
    const saving = store.getState().update({ mainAgentOnly: false });
    expect(store.getState().preferences?.mainAgentOnly).toBe(false);
    expect(api.settings.update).toHaveBeenCalledWith({
      notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, mainAgentOnly: false },
    });
    pending.resolve({ ok: true, preferences: withNotifications({ mainAgentOnly: false }) });
    await saving;
    expect(store.getState()).toMatchObject({
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, mainAgentOnly: false },
      error: null,
    });
  });

  it('update 失败时换回原值并记错误；还没读到设置时不发', async () => {
    const api = fakeApi();
    const store = createNotificationSettingsStore(api);
    await store.getState().update({ enabled: false });
    expect(api.settings.update).not.toHaveBeenCalled();

    await store.getState().refresh();
    api.settings.update.mockRejectedValueOnce(new Error('IPC 断了'));
    await store.getState().update({ enabled: false });
    expect(store.getState()).toMatchObject({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
      error: 'IPC 断了',
    });
  });

  it('连着改：只认最近一次请求的回包', async () => {
    const api = fakeApi();
    const store = createNotificationSettingsStore(api);
    await store.getState().refresh();

    const first = deferred<PreferencesResult>();
    const second = deferred<PreferencesResult>();
    api.settings.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = store.getState().update({ sound: false });
    const two = store.getState().update({ askAndApproval: false });
    expect(api.settings.update).toHaveBeenLastCalledWith({
      notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, sound: false, askAndApproval: false },
    });

    second.resolve({
      ok: true,
      preferences: withNotifications({ sound: false, askAndApproval: false }),
    });
    await two;
    first.resolve({ ok: true, preferences: withNotifications({ sound: false }) });
    await one;
    expect(store.getState().preferences).toMatchObject({ sound: false, askAndApproval: false });
  });

  it('test 原样交回 Main 的结果，IPC 抛异常时折成 { ok: false }', async () => {
    const api = fakeApi();
    const store = createNotificationSettingsStore(api);
    expect(await store.getState().test()).toEqual({ ok: true });
    api.notifications.test.mockRejectedValueOnce(new Error('没有 preload'));
    expect(await store.getState().test()).toEqual({ ok: false, error: '没有 preload' });
  });
});
