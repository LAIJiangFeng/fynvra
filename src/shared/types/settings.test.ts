import { describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  DEFAULT_PREFERENCES,
  parsePickWorktreesRootInput,
  parsePreferences,
  parsePreferencesPatch,
  parseSettings,
  parseWorktreesRootInfoInput,
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

  it('保留 settings.json 里手写的 preferences.shellPath', () => {
    const shellPath = 'D:\\Software\\Git\\bin\\bash.exe';
    expect(parseSettings({ preferences: { theme: 'dark', shellPath } }).preferences).toEqual({
      theme: 'dark',
      sidePanelOpen: DEFAULT_PREFERENCES.sidePanelOpen,
      shellPath,
    });
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

  it('shellPath 只保留非空字符串（去掉首尾空白），没有默认值', () => {
    expect(parsePreferences({ shellPath: ' D:\\Software\\Git\\bin\\bash.exe ' })).toEqual({
      ...DEFAULT_PREFERENCES,
      shellPath: 'D:\\Software\\Git\\bin\\bash.exe',
    });
    for (const shellPath of [undefined, null, 42, '', '   ', ['bash.exe']]) {
      expect(parsePreferences({ shellPath })).not.toHaveProperty('shellPath');
    }
  });

  it('worktreesRoot 保留绝对路径（去掉首尾空白），没有默认值', () => {
    for (const worktreesRoot of [
      'D:\\worktrees',
      'd:/worktrees',
      '\\\\nas\\share\\wt',
      '/srv/wt',
    ]) {
      expect(parsePreferences({ worktreesRoot: ` ${worktreesRoot} ` })).toEqual({
        ...DEFAULT_PREFERENCES,
        worktreesRoot,
      });
    }
    expect(parseSettings({ preferences: { worktreesRoot: 'E:\\wt' } }).preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      worktreesRoot: 'E:\\wt',
    });
  });

  it('lastModelByWorkspace 只保留合法的 id 引用（服务 id / 模型 id / 思考档位），没有默认值', () => {
    expect(
      parsePreferences({
        lastModelByWorkspace: {
          'ws-1': { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'high' },
          'ws-2': { providerId: 'openai', modelId: 'gpt-5.5', apiKey: 'sk-x', baseUrl: 'http://x' },
        },
      }).lastModelByWorkspace
    ).toEqual({
      'ws-1': { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'high' },
      'ws-2': { providerId: 'openai', modelId: 'gpt-5.5' },
    });
    expect(parsePreferences({})).not.toHaveProperty('lastModelByWorkspace');
  });

  it('lastModelByWorkspace 逐条丢弃非法项，全部非法时去掉整个字段', () => {
    const parsed = parsePreferences({
      lastModelByWorkspace: {
        'ws-1': { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'ultra' },
        'ws-2': { providerId: '', modelId: 'gpt-5.5' },
        'ws-3': { providerId: 'openai' },
        '../ws': { providerId: 'openai', modelId: 'gpt-5.5' },
        'ws-4': 'openai/gpt-5.5',
        'ws-5': { providerId: 'openai', modelId: 'gpt-5.5' },
      },
    });
    expect(parsed.lastModelByWorkspace).toEqual({
      'ws-5': { providerId: 'openai', modelId: 'gpt-5.5' },
    });
    const polluted = parsePreferences(
      JSON.parse('{"lastModelByWorkspace": {"__proto__": {"providerId": "p", "modelId": "m"}}}')
    ).lastModelByWorkspace;
    expect(polluted && Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    for (const lastModelByWorkspace of [null, 'x', [], { 'ws-1': null }]) {
      expect(parsePreferences({ lastModelByWorkspace })).not.toHaveProperty('lastModelByWorkspace');
    }
  });

  it('worktreesRoot 丢弃相对路径与非字符串（回到默认位置）', () => {
    for (const worktreesRoot of [
      undefined,
      null,
      42,
      '',
      '   ',
      'worktrees',
      './worktrees',
      '..\\worktrees',
      'D:worktrees',
      ['D:\\worktrees'],
    ]) {
      expect(parsePreferences({ worktreesRoot })).not.toHaveProperty('worktreesRoot');
    }
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
    ['shellPath（只能手改 settings.json，Renderer 不传路径）', { shellPath: 'C:\\x\\bash.exe' }],
    [
      'worktreesRoot（只经 settings:pick-worktrees-root 由 Main 弹框）',
      { worktreesRoot: 'D:\\wt' },
    ],
    [
      'lastModelByWorkspace（Main 在新建会话、切换模型时写入）',
      { lastModelByWorkspace: { 'ws-1': { providerId: 'openai', modelId: 'gpt-5.5' } } },
    ],
    ['原型污染键', JSON.parse('{"__proto__": {"theme": "dark"}}')],
  ])('拒绝 %s', (_label, raw) => {
    expect(parsePreferencesPatch(raw)).toBeNull();
  });
});

describe('parsePickWorktreesRootInput（IPC 入参收窄）', () => {
  it('无参弹目录框，{ reset: true } 恢复默认', () => {
    expect(parsePickWorktreesRootInput(undefined)).toEqual({ reset: false });
    expect(parsePickWorktreesRootInput({ reset: true })).toEqual({ reset: true });
    expect(parsePickWorktreesRootInput({ reset: false })).toEqual({ reset: false });
  });

  it.each([
    ['路径字符串', 'D:\\wt'],
    ['null', null],
    ['数组', [{ reset: true }]],
    ['类型不符', { reset: 'true' }],
    ['带路径的对象', { reset: false, path: 'D:\\wt' }],
    ['原型污染键', JSON.parse('{"__proto__": {"reset": true}}')],
  ])('拒绝 %s', (_label, raw) => {
    expect(parsePickWorktreesRootInput(raw)).toBeNull();
  });
});

describe('parseWorktreesRootInfoInput（IPC 入参收窄）', () => {
  it('默认统计占用，{ usage: false } 只取路径', () => {
    expect(parseWorktreesRootInfoInput(undefined)).toEqual({ usage: true });
    expect(parseWorktreesRootInfoInput({ usage: false })).toEqual({ usage: false });
    expect(parseWorktreesRootInfoInput({ usage: true })).toEqual({ usage: true });
  });

  it.each([
    ['工作区 id', 'ws-1'],
    ['null', null],
    ['类型不符', { usage: 1 }],
    ['未知字段', { usage: true, workspaceId: 'ws-1' }],
  ])('拒绝 %s', (_label, raw) => {
    expect(parseWorktreesRootInfoInput(raw)).toBeNull();
  });
});
