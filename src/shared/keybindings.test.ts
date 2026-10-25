import { describe, expect, it } from 'vitest';
import {
  ACTION_IDS,
  type ActionId,
  chordFromEvent,
  defaultChord,
  findConflict,
  formatChord,
  isAllowedChord,
  KEY_ACTIONS,
  type KeyEventLike,
  type KeyPlatform,
  keyPlatformOf,
  normalizeChord,
  parseKeybindingOverrides,
  parseKeybindingPatch,
  resolveKeybindings,
  scopesOverlap,
  toAriaKeyShortcuts,
} from './keybindings';

const PLATFORMS: KeyPlatform[] = ['mac', 'windows', 'linux'];

function key(init: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>): KeyEventLike {
  return { code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init };
}

describe('normalizeChord', () => {
  it('规整大小写、空白与修饰键顺序（Ctrl、Alt、Shift、Meta、键）', () => {
    expect(normalizeChord('ctrl+shift+k')).toBe('ctrl+shift+k');
    expect(normalizeChord('Shift+Ctrl+K')).toBe('ctrl+shift+k');
    expect(normalizeChord(' Meta + shift + ALT + ctrl + p ')).toBe('ctrl+alt+shift+meta+p');
  });

  it('认修饰键与键名的别名', () => {
    expect(normalizeChord('Control+Option+Cmd+P')).toBe('ctrl+alt+meta+p');
    expect(normalizeChord('command+super+win+k')).toBe('meta+k');
    expect(normalizeChord('Esc')).toBe('escape');
    expect(normalizeChord('shift+Return')).toBe('shift+enter');
    expect(normalizeChord('Up')).toBe('arrowup');
    expect(normalizeChord('ctrl+comma')).toBe('ctrl+,');
    expect(normalizeChord('ctrl+shift+BracketLeft')).toBe('ctrl+shift+[');
    expect(normalizeChord('F5')).toBe('f5');
    expect(normalizeChord('alt+Space')).toBe('alt+space');
  });

  it('加号键写作 plus，也接受末尾的「++」', () => {
    expect(normalizeChord('ctrl++')).toBe('ctrl+plus');
    expect(normalizeChord('Ctrl+Plus')).toBe('ctrl+plus');
    expect(normalizeChord('+')).toBe('plus');
  });

  it('不给平台时保留 mod；给了平台按平台展开（macOS 是 ⌘，其他是 Ctrl）', () => {
    expect(normalizeChord('Shift+Mod+[')).toBe('mod+shift+[');
    expect(normalizeChord('CmdOrCtrl+K')).toBe('mod+k');
    expect(normalizeChord('mod+shift+[', 'mac')).toBe('shift+meta+[');
    expect(normalizeChord('mod+shift+[', 'windows')).toBe('ctrl+shift+[');
    expect(normalizeChord('mod+k', 'linux')).toBe('ctrl+k');
  });

  it('重复的修饰键合并；展开 mod 后与同名修饰键合并', () => {
    expect(normalizeChord('ctrl+control+k')).toBe('ctrl+k');
    expect(normalizeChord('mod+ctrl+k', 'windows')).toBe('ctrl+k');
    expect(normalizeChord('mod+ctrl+k', 'mac')).toBe('ctrl+meta+k');
  });

  it.each([
    '',
    '   ',
    'ctrl',
    'ctrl+shift',
    'ctrl+',
    'ctrl+ +k',
    'hyper+k',
    'ctrl+kk',
    'ctrl+é',
    'k+ctrl',
    'f25',
    'ctrl+shift+{',
  ])('不合法的按键串 %j 返回 null', (input) => {
    expect(normalizeChord(input)).toBeNull();
  });
});

describe('chordFromEvent', () => {
  it('字母认键面，大写（Shift）也规整成小写', () => {
    expect(chordFromEvent(key({ key: 'n', code: 'KeyN', ctrlKey: true }))).toBe('ctrl+n');
    expect(chordFromEvent(key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+n'
    );
    // AZERTY：键面是 a 的键物理位置是 KeyQ，按键面认
    expect(chordFromEvent(key({ key: 'a', code: 'KeyQ', ctrlKey: true }))).toBe('ctrl+a');
  });

  it('数字与符号认物理位置：按着 Shift 时 key 变成 { ! < 也一样', () => {
    expect(
      chordFromEvent(key({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }))
    ).toBe('ctrl+shift+[');
    expect(
      chordFromEvent(key({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }))
    ).toBe('ctrl+shift+]');
    expect(chordFromEvent(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+1'
    );
    expect(chordFromEvent(key({ key: ',', code: 'Comma', ctrlKey: true }))).toBe('ctrl+,');
    expect(chordFromEvent(key({ key: ',', code: 'Comma', metaKey: true }))).toBe('meta+,');
  });

  it('命名键', () => {
    expect(chordFromEvent(key({ key: 'Enter', code: 'Enter' }))).toBe('enter');
    expect(chordFromEvent(key({ key: 'Enter', code: 'NumpadEnter', shiftKey: true }))).toBe(
      'shift+enter'
    );
    expect(chordFromEvent(key({ key: 'Tab', code: 'Tab', shiftKey: true }))).toBe('shift+tab');
    expect(chordFromEvent(key({ key: 'Escape', code: 'Escape' }))).toBe('escape');
    expect(chordFromEvent(key({ key: 'ArrowUp', code: 'ArrowUp' }))).toBe('arrowup');
    expect(chordFromEvent(key({ key: ' ', code: 'Space', altKey: true }))).toBe('alt+space');
    expect(chordFromEvent(key({ key: 'F5', code: 'F5' }))).toBe('f5');
  });

  it('非拉丁布局的字母、输入法处理中的按键在带 Ctrl / Alt / Meta 时按物理位置认', () => {
    expect(chordFromEvent(key({ key: 'т', code: 'KeyN', ctrlKey: true }))).toBe('ctrl+n');
    expect(chordFromEvent(key({ key: 'Process', code: 'KeyN', ctrlKey: true }))).toBe('ctrl+n');
    expect(chordFromEvent(key({ key: 'Dead', code: 'Quote', ctrlKey: true }))).toBe("ctrl+'");
  });

  it('只按修饰键、输入法组字、AltGr 打字、认不出的键返回 null', () => {
    expect(chordFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Alt', code: 'AltLeft', altKey: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Enter', code: 'Enter', isComposing: true }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Process', code: 'KeyN' }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Dead', code: 'Quote' }))).toBeNull();
    expect(
      chordFromEvent(
        key({
          key: '@',
          code: 'KeyQ',
          ctrlKey: true,
          altKey: true,
          getModifierState: (name) => name === 'AltGraph',
        })
      )
    ).toBeNull();
    expect(chordFromEvent(key({ key: 'Unidentified', code: '' }))).toBeNull();
    expect(chordFromEvent(key({ key: '*', code: 'NumpadMultiply', ctrlKey: true }))).toBeNull();
  });

  it('小键盘：数字同主键盘，加号是 plus', () => {
    expect(chordFromEvent(key({ key: '1', code: 'Numpad1', ctrlKey: true }))).toBe('ctrl+1');
    expect(chordFromEvent(key({ key: '+', code: 'NumpadAdd', ctrlKey: true }))).toBe('ctrl+plus');
  });

  it('产出的按键串都能被 normalizeChord 原样认回', () => {
    const chords = [
      chordFromEvent(key({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })),
      chordFromEvent(key({ key: '+', code: 'NumpadAdd', altKey: true })),
      chordFromEvent(key({ key: ' ', code: 'Space', shiftKey: true })),
      chordFromEvent(key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, metaKey: true })),
    ];
    for (const chord of chords) {
      expect(chord).not.toBeNull();
      expect(normalizeChord(chord ?? '')).toBe(chord);
    }
  });
});

describe('formatChord', () => {
  it('Windows / Linux：Ctrl+Shift+K 这种写法', () => {
    expect(formatChord('ctrl+shift+k', 'windows')).toBe('Ctrl+Shift+K');
    expect(formatChord('ctrl+alt+shift+meta+k', 'windows')).toBe('Ctrl+Alt+Shift+Win+K');
    expect(formatChord('meta+k', 'linux')).toBe('Super+K');
    expect(formatChord('ctrl+,', 'windows')).toBe('Ctrl+,');
    expect(formatChord('ctrl+shift+[', 'windows')).toBe('Ctrl+Shift+[');
    expect(formatChord('shift+enter', 'windows')).toBe('Shift+Enter');
    expect(formatChord('escape', 'linux')).toBe('Esc');
    expect(formatChord('arrowup', 'windows')).toBe('↑');
    expect(formatChord('ctrl+plus', 'windows')).toBe('Ctrl++');
    expect(formatChord('f5', 'windows')).toBe('F5');
  });

  it('macOS：符号连写，顺序 ⌃⌥⇧⌘', () => {
    expect(formatChord('shift+meta+k', 'mac')).toBe('⇧⌘K');
    expect(formatChord('ctrl+alt+shift+meta+k', 'mac')).toBe('⌃⌥⇧⌘K');
    expect(formatChord('meta+,', 'mac')).toBe('⌘,');
    expect(formatChord('shift+enter', 'mac')).toBe('⇧↩');
    expect(formatChord('shift+tab', 'mac')).toBe('⇧⇥');
    expect(formatChord('escape', 'mac')).toBe('Esc');
  });

  it('mod 按平台显示', () => {
    expect(formatChord('mod+n', 'mac')).toBe('⌘N');
    expect(formatChord('mod+n', 'windows')).toBe('Ctrl+N');
  });

  it('认不出的串原样返回', () => {
    expect(formatChord('hyper+k', 'windows')).toBe('hyper+k');
  });
});

describe('toAriaKeyShortcuts', () => {
  it('用 aria-keyshortcuts 的键名', () => {
    expect(toAriaKeyShortcuts('shift+tab')).toBe('Shift+Tab');
    expect(toAriaKeyShortcuts('ctrl+shift+k')).toBe('Control+Shift+K');
    expect(toAriaKeyShortcuts('alt+meta+,')).toBe('Alt+Meta+,');
    expect(toAriaKeyShortcuts('arrowup')).toBe('ArrowUp');
    expect(toAriaKeyShortcuts('escape')).toBe('Escape');
    expect(toAriaKeyShortcuts('shift+space')).toBe('Shift+Space');
    expect(toAriaKeyShortcuts('ctrl+plus')).toBe('Control+Plus');
    expect(toAriaKeyShortcuts('hyper+k')).toBe('');
  });
});

describe('keyPlatformOf', () => {
  it('process.platform → 按键平台', () => {
    expect(keyPlatformOf('darwin')).toBe('mac');
    expect(keyPlatformOf('win32')).toBe('windows');
    expect(keyPlatformOf('linux')).toBe('linux');
    expect(keyPlatformOf('freebsd')).toBe('linux');
  });
});

describe('默认键', () => {
  it('Windows / Linux 用 Ctrl，macOS 用 ⌘', () => {
    expect(defaultChord('new-session', 'windows')).toBe('ctrl+n');
    expect(defaultChord('open-settings', 'windows')).toBe('ctrl+,');
    expect(defaultChord('toggle-side-panel', 'linux')).toBe('ctrl+b');
    expect(defaultChord('focus-composer', 'windows')).toBe('ctrl+l');
    expect(defaultChord('prev-session', 'windows')).toBe('ctrl+shift+[');
    expect(defaultChord('next-session', 'windows')).toBe('ctrl+shift+]');
    expect(defaultChord('search-sessions', 'windows')).toBe('ctrl+k');
    expect(defaultChord('open-model-picker', 'windows')).toBe('ctrl+m');
    expect(defaultChord('new-session', 'mac')).toBe('meta+n');
    expect(defaultChord('prev-session', 'mac')).toBe('shift+meta+[');
    expect(defaultChord('open-model-picker', 'mac')).toBe('meta+m');
  });

  it('输入框动作不带修饰键', () => {
    for (const platform of PLATFORMS) {
      expect(defaultChord('send', platform)).toBe('enter');
      expect(defaultChord('newline', platform)).toBe('shift+enter');
      expect(defaultChord('cycle-approval', platform)).toBe('shift+tab');
      expect(defaultChord('stop-turn', platform)).toBe('escape');
      expect(defaultChord('history-prev', platform)).toBe('arrowup');
      expect(defaultChord('history-next', platform)).toBe('arrowdown');
    }
  });

  it('每个动作的默认键都合法，并且在任何平台上都互不冲突', () => {
    for (const platform of PLATFORMS) {
      const bindings = resolveKeybindings(undefined, platform);
      for (const action of ACTION_IDS) {
        expect(isAllowedChord(action, bindings[action])).toBe(true);
        expect(findConflict(action, bindings[action], bindings, platform)).toBeNull();
      }
    }
  });

  it('全局动作在输入框里也响应（allowInInput），这样输入时也能新建会话、切会话', () => {
    const globals = ACTION_IDS.filter((action) => KEY_ACTIONS[action].scope === 'global');
    expect(globals).toEqual([
      'new-session',
      'open-settings',
      'toggle-side-panel',
      'focus-composer',
      'prev-session',
      'next-session',
      'search-sessions',
    ]);
    for (const action of globals) expect(KEY_ACTIONS[action].allowInInput).toBe(true);
  });
});

describe('resolveKeybindings', () => {
  it('覆盖表里的键规整后按平台展开；其余用默认键', () => {
    const bindings = resolveKeybindings(
      { 'new-session': 'Alt+Ctrl+N', send: 'mod+Enter' },
      'windows'
    );
    expect(bindings['new-session']).toBe('ctrl+alt+n');
    expect(bindings.send).toBe('ctrl+enter');
    expect(bindings.newline).toBe('shift+enter');
    expect(resolveKeybindings({ send: 'mod+Enter' }, 'mac').send).toBe('meta+enter');
  });

  it('不合法的覆盖项回落默认键', () => {
    const bindings = resolveKeybindings(
      {
        'new-session': 'n',
        'open-settings': 'shift+s',
        send: 'm',
        newline: 'hyper+enter',
      },
      'windows'
    );
    expect(bindings['new-session']).toBe('ctrl+n');
    expect(bindings['open-settings']).toBe('ctrl+,');
    expect(bindings.send).toBe('enter');
    expect(bindings.newline).toBe('shift+enter');
  });
});

describe('isAllowedChord', () => {
  it('全局动作要带 Ctrl / Alt / Meta（F 键除外）：单按或只加 Shift 是在打字', () => {
    const global: ActionId = 'search-sessions';
    expect(isAllowedChord(global, 'ctrl+k')).toBe(true);
    expect(isAllowedChord(global, 'alt+k')).toBe(true);
    expect(isAllowedChord(global, 'meta+k')).toBe(true);
    expect(isAllowedChord(global, 'mod+k')).toBe(true);
    expect(isAllowedChord(global, 'f2')).toBe(true);
    expect(isAllowedChord(global, 'shift+f2')).toBe(true);
    expect(isAllowedChord(global, 'k')).toBe(false);
    expect(isAllowedChord(global, 'shift+k')).toBe(false);
    expect(isAllowedChord(global, 'enter')).toBe(false);
    expect(isAllowedChord(global, 'escape')).toBe(false);
    expect(isAllowedChord(global, 'arrowdown')).toBe(false);
  });

  it('输入框动作另外允许单按 Enter、Tab、Esc、↑、↓（可加 Shift）', () => {
    const composer: ActionId = 'open-model-picker';
    for (const chord of ['enter', 'shift+enter', 'tab', 'shift+tab', 'escape', 'arrowup', 'f3']) {
      expect(isAllowedChord(composer, chord)).toBe(true);
    }
    for (const chord of ['m', 'shift+m', 'space', 'backspace', 'delete', 'arrowleft', 'home']) {
      expect(isAllowedChord(composer, chord)).toBe(false);
    }
    expect(isAllowedChord(composer, 'ctrl+m')).toBe(true);
  });

  it('不合法的按键串一律不允许', () => {
    expect(isAllowedChord('send', 'hyper+enter')).toBe(false);
  });
});

describe('findConflict', () => {
  const windows = resolveKeybindings(undefined, 'windows');

  it('同作用域同键：报出占用它的动作', () => {
    expect(findConflict('open-settings', 'ctrl+n', windows, 'windows')).toEqual({
      action: 'new-session',
    });
    expect(findConflict('send', 'shift+tab', windows, 'windows')).toEqual({
      action: 'cycle-approval',
    });
  });

  it('键还是自己的不算冲突', () => {
    expect(findConflict('new-session', 'ctrl+n', windows, 'windows')).toBeNull();
  });

  it('全局动作在输入框里也响应，所以与输入框动作同键也算冲突', () => {
    expect(findConflict('open-model-picker', 'ctrl+n', windows, 'windows')).toEqual({
      action: 'new-session',
    });
    expect(findConflict('search-sessions', 'ctrl+m', windows, 'windows')).toEqual({
      action: 'open-model-picker',
    });
  });

  it('剪切板、撤销、全选这些编辑键保留，按平台判断', () => {
    expect(findConflict('search-sessions', 'ctrl+c', windows, 'windows')).toEqual({
      reserved: 'copy',
    });
    expect(findConflict('send', 'ctrl+z', windows, 'windows')).toEqual({ reserved: 'undo' });
    expect(findConflict('send', 'ctrl+shift+z', windows, 'windows')).toEqual({ reserved: 'redo' });
    expect(findConflict('send', 'ctrl+a', windows, 'windows')).toEqual({ reserved: 'select-all' });
    const mac = resolveKeybindings(undefined, 'mac');
    expect(findConflict('search-sessions', 'meta+v', mac, 'mac')).toEqual({ reserved: 'paste' });
    // macOS 上 ⌃C 不是复制
    expect(findConflict('search-sessions', 'ctrl+c', mac, 'mac')).toBeNull();
  });
});

describe('scopesOverlap', () => {
  it('同作用域重叠；全局动作只有在输入框里也响应时才与输入框动作重叠', () => {
    const composer = { scope: 'composer', chord: 'enter' } as const;
    expect(scopesOverlap(composer, composer)).toBe(true);
    expect(scopesOverlap({ scope: 'global', chord: 'mod+k', allowInInput: true }, composer)).toBe(
      true
    );
    expect(scopesOverlap(composer, { scope: 'global', chord: 'mod+k' })).toBe(false);
  });
});

describe('parseKeybindingOverrides（settings.json，宽松）', () => {
  it('保留已知动作的合法键（规整后，mod 原样保留）', () => {
    expect(parseKeybindingOverrides({ 'new-session': 'Alt+Ctrl+N', send: 'Mod+Enter' })).toEqual({
      'new-session': 'ctrl+alt+n',
      send: 'mod+enter',
    });
  });

  it('逐条丢弃未知动作、非字符串、认不出的键与该作用域不允许的键', () => {
    expect(
      parseKeybindingOverrides({
        'new-session': 'ctrl+alt+n',
        'no-such-action': 'ctrl+j',
        'open-settings': 7,
        'toggle-side-panel': 'hyper+b',
        'search-sessions': 'k',
        send: 'm',
      })
    ).toEqual({ 'new-session': 'ctrl+alt+n' });
  });

  it('__proto__、constructor 这类键不是动作，也改不到原型', () => {
    const parsed = parseKeybindingOverrides(
      JSON.parse('{"__proto__":"ctrl+p","constructor":"ctrl+o","send":"ctrl+enter"}')
    );
    expect(parsed).toEqual({ send: 'ctrl+enter' });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it.each([undefined, null, 'ctrl+n', [], {}, { send: 'm' }])(
    '%j 没有可用的项：返回 undefined',
    (raw) => {
      expect(parseKeybindingOverrides(raw)).toBeUndefined();
    }
  );
});

describe('parseKeybindingPatch（settings:update，严格）', () => {
  it('合法的覆盖表规整后返回；空表合法（全部重置）', () => {
    expect(parseKeybindingPatch({ 'prev-session': 'ctrl+shift+BracketLeft' })).toEqual({
      'prev-session': 'ctrl+shift+[',
    });
    expect(parseKeybindingPatch({})).toEqual({});
  });

  it.each([
    undefined,
    null,
    'ctrl+n',
    [],
    { 'no-such-action': 'ctrl+j' },
    { 'new-session': 7 },
    { 'new-session': 'hyper+n' },
    { 'new-session': 'n' },
    { 'new-session': 'ctrl+alt+n', send: 'm' },
  ])('任何一条不合法整个作废：%j', (raw) => {
    expect(parseKeybindingPatch(raw)).toBeNull();
  });
});
