import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_IDLE_DAYS,
  createDefaultSettings,
  DEFAULT_PREFERENCES,
  DELETE_ARCHIVED_DAYS,
  languageOf,
  parsePickWorktreesRootInput,
  parsePreferences,
  parsePreferencesPatch,
  parseSettings,
  parseWorktreesRootInfoInput,
  SETTINGS_VERSION,
  sessionPreferencesOf,
  timelinePreferencesOf,
} from './settings';

const workspace = {
  id: 'ws-1',
  name: 'fynvra',
  repoPath: '/repos/fynvra',
  vcs: 'git' as const,
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

describe('会话与时间线偏好', () => {
  const sessions = { archiveIdleDays: 14, cleanupWorktreeOnArchive: true, deleteArchivedDays: 90 };
  const timeline = {
    compactReadonlyTools: false,
    autoExpandEdits: false,
    autoExpandThinking: false,
    foldHistoryTurns: true,
  };

  it('parsePreferences 保留合法的天数与开关，没写过的字段不出现', () => {
    expect(parsePreferences({ ...sessions, ...timeline })).toEqual({
      ...DEFAULT_PREFERENCES,
      ...sessions,
      ...timeline,
    });
    expect(parsePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(parseSettings({ preferences: { archiveIdleDays: 0 } }).preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      archiveIdleDays: 0,
    });
  });

  it('parsePreferences 丢弃不在选项里的天数与非布尔开关', () => {
    const parsed = parsePreferences({
      archiveIdleDays: 10,
      deleteArchivedDays: 7,
      cleanupWorktreeOnArchive: 'yes',
      compactReadonlyTools: 1,
      autoExpandEdits: null,
      autoExpandThinking: 'false',
      foldHistoryTurns: [],
    });
    expect(parsed).toEqual(DEFAULT_PREFERENCES);
    for (const days of [-7, 7.5, '7', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parsePreferences({ archiveIdleDays: days })).not.toHaveProperty('archiveIdleDays');
    }
    expect(parsePreferences({ deleteArchivedDays: 14 })).not.toHaveProperty('deleteArchivedDays');
  });

  it('选项：闲置归档 关闭 / 7 / 14 / 30 / 90，过期删除 永不 / 30 / 90', () => {
    expect(ARCHIVE_IDLE_DAYS).toEqual([0, 7, 14, 30, 90]);
    expect(DELETE_ARCHIVED_DAYS).toEqual([0, 30, 90]);
  });

  it('生效值补默认：归档关闭、不清理、永不删除；精简只读、展开编辑与思考开，折叠历史轮次关', () => {
    expect(sessionPreferencesOf(DEFAULT_PREFERENCES)).toEqual({
      archiveIdleDays: 0,
      cleanupWorktreeOnArchive: false,
      deleteArchivedDays: 0,
    });
    expect(timelinePreferencesOf(DEFAULT_PREFERENCES)).toEqual({
      compactReadonlyTools: true,
      autoExpandEdits: true,
      autoExpandThinking: true,
      foldHistoryTurns: false,
    });
    const preferences = parsePreferences({ ...sessions, ...timeline });
    expect(sessionPreferencesOf(preferences)).toEqual(sessions);
    expect(timelinePreferencesOf(preferences)).toEqual(timeline);
    expect(sessionPreferencesOf({ ...DEFAULT_PREFERENCES, deleteArchivedDays: 30 })).toEqual({
      archiveIdleDays: 0,
      cleanupWorktreeOnArchive: false,
      deleteArchivedDays: 30,
    });
  });

  it('parsePreferencesPatch 接受合法的天数与开关', () => {
    expect(parsePreferencesPatch(sessions)).toEqual(sessions);
    expect(parsePreferencesPatch(timeline)).toEqual(timeline);
    expect(parsePreferencesPatch({ archiveIdleDays: 0, deleteArchivedDays: 0 })).toEqual({
      archiveIdleDays: 0,
      deleteArchivedDays: 0,
    });
  });

  it.each([
    ['不在选项里的闲置天数', { archiveIdleDays: 10 }],
    ['字符串天数', { archiveIdleDays: '7' }],
    ['不在选项里的删除天数', { deleteArchivedDays: 14 }],
    ['负数', { deleteArchivedDays: -30 }],
    ['非布尔的清理开关', { cleanupWorktreeOnArchive: 1 }],
    ['非布尔的时间线开关', { foldHistoryTurns: 'true' }],
    ['合法字段混着非法值', { compactReadonlyTools: true, autoExpandEdits: null }],
  ])('parsePreferencesPatch 拒绝%s', (_label, raw) => {
    expect(parsePreferencesPatch(raw)).toBeNull();
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

// --- keybindings ---
describe('preferences.keybindings（快捷键覆盖表）', () => {
  it('parsePreferences 保留合法的覆盖项（规整后，mod 原样保留），没有默认值', () => {
    expect(
      parsePreferences({ keybindings: { 'new-session': 'Alt+Ctrl+N', send: 'Mod+Enter' } })
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      keybindings: { 'new-session': 'ctrl+alt+n', send: 'mod+enter' },
    });
    expect(parsePreferences({})).not.toHaveProperty('keybindings');
  });

  it('parsePreferences 逐条丢弃非法项，全部非法时去掉整个字段', () => {
    expect(
      parsePreferences({
        keybindings: { 'new-session': 'ctrl+alt+n', 'no-such-action': 'ctrl+j', send: 'm' },
      }).keybindings
    ).toEqual({ 'new-session': 'ctrl+alt+n' });
    for (const keybindings of [null, 'ctrl+n', [], {}, { send: 'hyper+enter' }]) {
      expect(parsePreferences({ keybindings })).not.toHaveProperty('keybindings');
    }
  });

  it('parseSettings 读回 settings.json 里的覆盖表', () => {
    expect(
      parseSettings({ preferences: { keybindings: { 'search-sessions': 'ctrl+shift+f' } } })
        .preferences.keybindings
    ).toEqual({ 'search-sessions': 'ctrl+shift+f' });
  });

  it('parsePreferencesPatch 接受合法的覆盖表；空表表示全部重置', () => {
    expect(parsePreferencesPatch({ keybindings: { 'prev-session': 'Ctrl+Alt+Up' } })).toEqual({
      keybindings: { 'prev-session': 'ctrl+alt+arrowup' },
    });
    expect(parsePreferencesPatch({ theme: 'dark', keybindings: {} })).toEqual({
      theme: 'dark',
      keybindings: {},
    });
  });

  it.each([
    ['不是对象', 'ctrl+n'],
    ['数组', [['send', 'ctrl+enter']]],
    ['未知动作', { 'no-such-action': 'ctrl+j' }],
    ['认不出的键', { send: 'hyper+enter' }],
    ['全局动作不带 Ctrl / Alt', { 'new-session': 'n' }],
    ['有一条不合法', { 'new-session': 'ctrl+alt+n', send: 7 }],
  ])('parsePreferencesPatch 拒绝 %s', (_label, keybindings) => {
    expect(parsePreferencesPatch({ keybindings })).toBeNull();
  });
});

// --- language ---
describe('preferences.language（界面语言）', () => {
  it('parsePreferences 保留跟随系统 / 简体中文 / English，没写过时不出现（按跟随系统）', () => {
    for (const language of ['system', 'zh-CN', 'en'] as const) {
      expect(parsePreferences({ language })).toEqual({ ...DEFAULT_PREFERENCES, language });
    }
    expect(parsePreferences({})).not.toHaveProperty('language');
    expect(languageOf(parsePreferences({}))).toBe('system');
    expect(languageOf(parsePreferences({ language: 'en' }))).toBe('en');
  });

  it('parsePreferences 丢弃不认识的语言', () => {
    for (const language of ['zh', 'en-US', 'fr', '', null, 1]) {
      expect(parsePreferences({ language })).not.toHaveProperty('language');
    }
  });

  it('parsePreferencesPatch 接受合法的语言，拒绝不认识的', () => {
    expect(parsePreferencesPatch({ language: 'en' })).toEqual({ language: 'en' });
    expect(parsePreferencesPatch({ theme: 'dark', language: 'system' })).toEqual({
      theme: 'dark',
      language: 'system',
    });
    expect(parsePreferencesPatch({ language: 'en-US' })).toBeNull();
    expect(parsePreferencesPatch({ language: null })).toBeNull();
  });
});
