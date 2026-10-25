import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import { type NotificationPreferences, notificationPreferencesOf } from '@shared/types/settings';
import { create } from 'zustand';
import type { NotificationsApi } from '../../preload/domains/notifications';
import type { SettingsApi } from '../../preload/types';

export type NotificationSettingsApi = {
  settings: Pick<SettingsApi, 'get' | 'update'>;
  notifications: Pick<NotificationsApi, 'test'>;
};

export interface NotificationSettingsState {
  /** Main 生效的通知设置；还没读到时为 null */
  preferences: NotificationPreferences | null;
  /** 最近一次读取 / 保存失败的原因 */
  error: string | null;
  refresh(): Promise<void>;
  /** 改开关：界面先换上，整块交给 Main，回包后以 Main 为准；失败时换回 */
  update(patch: Partial<NotificationPreferences>): Promise<void>;
  /** 弹一条测试通知 */
  test(): Promise<IpcResult>;
}

async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 设置页「通知」的 store（Task 24）：设置在 settings.json 的 preferences.notifications，由 Main 持有。
 * 不读全局 window，便于在 node 环境测试；应用内实例见 ./settings。
 */
export function createNotificationSettingsStore(api: NotificationSettingsApi) {
  // 读取与保存共用一个序号：只认最近一次请求的回包
  let request = 0;
  return create<NotificationSettingsState>()((set, get) => ({
    preferences: null,
    error: null,

    async refresh() {
      const current = ++request;
      const result = await safely(() => api.settings.get());
      if (current !== request) return;
      set(
        result.ok
          ? { preferences: notificationPreferencesOf(result.preferences), error: null }
          : { error: result.error }
      );
    },

    async update(patch) {
      const previous = get().preferences;
      if (previous === null) return;
      const next = { ...previous, ...patch };
      const current = ++request;
      set({ preferences: next, error: null });
      const result = await safely(() => api.settings.update({ notifications: next }));
      if (current !== request) return;
      set(
        result.ok
          ? { preferences: notificationPreferencesOf(result.preferences) }
          : { preferences: previous, error: result.error }
      );
    },

    test: () => safely(() => api.notifications.test()),
  }));
}
