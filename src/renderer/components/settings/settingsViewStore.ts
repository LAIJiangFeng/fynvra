import { create } from 'zustand';

export const SETTINGS_SECTIONS = [
  'general',
  'git',
  'notifications',
  'providers',
  'roles',
  'workflows',
  'instructions',
  'skills',
  'mcp',
  'plugins',
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
  /** 等 git 装好后要接着初始化的工作区 id；离开设置即清空 */
  pendingGitInit: string | null;
  show(section?: SettingsSection): void;
  close(): void;
  toggle(): void;
  setSection(section: SettingsSection): void;
  showGitInstall(workspaceId: string): void;
}

/** 设置视图的开关与当前分组：纯界面状态，不持久化。 */
export const useSettingsViewStore = create<SettingsViewState>()((set) => ({
  open: false,
  section: 'providers',
  show: (section) => set((state) => ({ open: true, section: section ?? state.section })),
  pendingGitInit: null,
  close: () => set({ open: false, pendingGitInit: null }),
  toggle: () =>
    set((state) => (state.open ? { open: false, pendingGitInit: null } : { open: true })),
  setSection: (section) => set({ section }),
  showGitInstall: (workspaceId) => set({ open: true, section: 'git', pendingGitInit: workspaceId }),
}));
