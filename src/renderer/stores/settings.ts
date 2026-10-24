import { createSettingsStore } from './createSettingsStore';

export type { SettingsState } from './createSettingsStore';

/** 界面偏好（主题、侧面板），经 preload 持久化到 settings.json。 */
export const useSettingsStore = createSettingsStore(window.fynvra.settings);

// 其他窗口改了偏好：从 Main 重读最新值
window.fynvra.settings.onChanged(() => {
  void useSettingsStore.persist.rehydrate();
});
