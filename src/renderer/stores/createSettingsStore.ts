import type { Language } from '@shared/i18n';
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  parsePreferences,
  SETTINGS_VERSION,
  sidebarOpenOf,
  type ThemeMode,
} from '@shared/types/settings';
import { create } from 'zustand';
import { type PersistStorage, persist } from 'zustand/middleware';
import type { SettingsApi } from '../../preload/types';

export type PreferencesBridge = Pick<SettingsApi, 'get' | 'update'>;

export interface SettingsState extends Preferences {
  setTheme(theme: ThemeMode): void;
  setLanguage(language: Language): void;
  toggleSidePanel(): void;
  toggleSidebar(): void;
  /** 展开左栏；已经展开时什么都不做（不落盘） */
  openSidebar(): void;
}

/**
 * 界面偏好 store：zustand persist 经 preload 落到 Main 持有的 settings.json。
 *
 * 写闸门：persist 对每次 set 都会 setItem，不管是否已水合。Main 回包之前内存里是默认值，
 * 这时落盘会用默认值覆盖磁盘。闸门在 onRehydrateStorage（merge 之后）才打开，
 * 开闸前的写入直接丢弃；读取失败则整个运行期保持关闸。
 *
 * 不读全局 window，便于在 node 环境测试；应用内实例见 ./settings。
 */
export function createSettingsStore(api: PreferencesBridge) {
  let writable = false;

  const storage: PersistStorage<Preferences> = {
    async getItem() {
      const result = await api.get();
      if (!result.ok) throw new Error(result.error);
      return { state: result.preferences, version: SETTINGS_VERSION };
    },
    async setItem(_name, value) {
      if (!writable) return;
      const result = await api.update(value.state);
      if (!result.ok) console.error('[settings] 保存偏好失败：', result.error);
    },
    removeItem() {
      // 偏好由 Main 持有，Renderer 不删除整块配置
    },
  };

  return create<SettingsState>()(
    persist(
      (set, get) => ({
        ...DEFAULT_PREFERENCES,
        setTheme: (theme) => set({ theme }),
        setLanguage: (language) => set({ language }),
        toggleSidePanel: () => set((state) => ({ sidePanelOpen: !state.sidePanelOpen })),
        toggleSidebar: () => set((state) => ({ sidebarOpen: !sidebarOpenOf(state) })),
        openSidebar: () => {
          if (!sidebarOpenOf(get())) set({ sidebarOpen: true });
        },
      }),
      {
        name: 'preferences',
        version: SETTINGS_VERSION,
        storage,
        // 左栏没切换过、语言没选过时不写（按展开、跟随系统）；切换过就一直写，Main 按字段合并
        partialize: ({ theme, sidePanelOpen, sidebarOpen, language }): Preferences => ({
          theme,
          sidePanelOpen,
          ...(sidebarOpen !== undefined ? { sidebarOpen } : {}),
          ...(language ? { language } : {}),
        }),
        merge: (persisted, current) => ({ ...current, ...parsePreferences(persisted) }),
        onRehydrateStorage: () => (_state, error) => {
          if (error) {
            console.error('[settings] 读取偏好失败，本次运行不保存修改：', error);
            return;
          }
          writable = true;
        },
      }
    )
  );
}
