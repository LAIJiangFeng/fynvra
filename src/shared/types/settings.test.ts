import { describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  DEFAULT_PREFERENCES,
  parsePreferences,
  parsePreferencesPatch,
  parseSettings,
  SETTINGS_VERSION,
} from './settings';

const workspace = {
  id: 'ws-1',
  name: 'fynvra',
  repoPath: '/repos/fynvra',
  defaultBranch: 'main',
};

describe('parseSettings', () => {
  it.each([undefined, null, 'settings', 42, [], [workspace]])(
    '非对象输入 %j 回落为默认值',
    (raw) => {
      expect(parseSettings(raw)).toEqual(createDefaultSettings());
    }
  );

  it('保留合法字段，非法字段逐项回落默认值', () => {
    expect(
      parseSettings({
        version: 1,
        preferences: { theme: 'dark', sidePanelOpen: 'yes' },
        workspaces: [workspace],
      })
    ).toEqual({
      version: SETTINGS_VERSION,
      preferences: { theme: 'dark', sidePanelOpen: DEFAULT_PREFERENCES.sidePanelOpen },
      workspaces: [workspace],
    });
  });

  it('未知主题回落为 system，未知顶层键被丢弃', () => {
    const parsed = parseSettings({ preferences: { theme: 'neon' }, extra: { nested: true } });
    expect(parsed.preferences.theme).toBe('system');
    expect(parsed).not.toHaveProperty('extra');
  });

  it('丢弃字段缺失、类型不符或 id 非法的工作区，重复 id 只保留第一条', () => {
    const parsed = parseSettings({
      workspaces: [
        workspace,
        { ...workspace, name: 'duplicate' },
        { ...workspace, id: 'ws-2', repoPath: '' },
        { ...workspace, id: 'ws-3', defaultBranch: 7 },
        { ...workspace, id: '../escape' },
        { id: 'ws-4' },
        'ws-5',
        { ...workspace, id: 'ws-6', name: 'kept' },
      ],
    });
    expect(parsed.workspaces).toEqual([workspace, { ...workspace, id: 'ws-6', name: 'kept' }]);
  });

  it('版本号统一规整为当前版本', () => {
    expect(parseSettings({ version: 99 }).version).toBe(SETTINGS_VERSION);
  });

  it('每次返回新对象，修改结果不会污染默认值', () => {
    const first = parseSettings(undefined);
    first.preferences.theme = 'dark';
    first.workspaces.push(workspace);
    expect(parseSettings(undefined)).toEqual(createDefaultSettings());
    expect(DEFAULT_PREFERENCES.theme).toBe('system');
  });
});

describe('parsePreferences', () => {
  it('宽松收窄：逐字段取合法值，其余用默认值', () => {
    expect(parsePreferences({ theme: 'light', sidePanelOpen: false })).toEqual({
      theme: 'light',
      sidePanelOpen: false,
    });
    expect(parsePreferences({ theme: 1, sidePanelOpen: null })).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('parsePreferencesPatch（IPC 入参收窄）', () => {
  it('接受已知字段的合法部分更新', () => {
    expect(parsePreferencesPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(parsePreferencesPatch({ theme: 'system', sidePanelOpen: false })).toEqual({
      theme: 'system',
      sidePanelOpen: false,
    });
    expect(parsePreferencesPatch({})).toEqual({});
  });

  it.each([
    ['null', null],
    ['字符串', 'dark'],
    ['数组', [{ theme: 'dark' }]],
    ['未知主题', { theme: 'neon' }],
    ['类型不符', { sidePanelOpen: 'true' }],
    ['未知字段', { theme: 'dark', workspaces: [] }],
    ['原型污染键', JSON.parse('{"__proto__": {"theme": "dark"}}')],
  ])('拒绝 %s', (_label, raw) => {
    expect(parsePreferencesPatch(raw)).toBeNull();
  });
});
