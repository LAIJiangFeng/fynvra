import { create } from 'zustand';

export const SETTINGS_SECTIONS = [
  'general',
  'notifications',
  'providers',
  'roles',
  'instructions',
  'skills',
  'mcp',
  'appearance',
  'keybindings',
  'usage',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

interface SettingsViewState {
  open: boolean;
  section: SettingsSection;
  show(section?: SettingsSection): void;
  close(): void;
  toggle(): void;
  setSection(section: SettingsSection): void;
}

/** 设置视图的开关与当前分组：纯界面状态，不持久化。 */
export const useSettingsViewStore = create<SettingsViewState>()((set) => ({
  open: false,
  section: 'providers',
  show: (section) => set((state) => ({ open: true, section: section ?? state.section })),
  close: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
  setSection: (section) => set({ section }),
}));
