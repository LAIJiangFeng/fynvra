import { describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGINS } from './officialPlugins';
import { isSettingsSection, SETTINGS_SECTIONS } from './settingsViewStore';

describe('官方插件入口', () => {
  it('侧边栏分组列表里没有 telegram，官方插件都不占侧边栏分组', () => {
    expect(SETTINGS_SECTIONS).not.toContain('telegram');
    expect(isSettingsSection('telegram')).toBe(false);
    for (const plugin of OFFICIAL_PLUGINS) expect(isSettingsSection(plugin.id)).toBe(false);
  });
});
