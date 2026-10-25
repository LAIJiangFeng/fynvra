import { asRecord } from './guards';

/**
 * 快捷键：动作表、默认键、按键串规整 / 显示 / 冲突检测。纯函数，Main（settings 收窄）与 Renderer 共用。
 *
 * 按键串（chord）形如 `ctrl+shift+k`：小写，修饰键按 ctrl、alt、shift、meta 排在前，最后是键。
 * 默认键里的 `mod` 在 macOS 是 ⌘（meta），其他平台是 Ctrl；settings.json 里的覆盖项不知道平台，
 * `mod` 原样保留，Renderer 按平台展开（{@link normalizeChord} 传平台）后再匹配与显示。
 */

/** 全局：窗口上监听；输入框：由 Composer 自己派发 */
export type KeyScope = 'global' | 'composer';
/** 决定 `mod` 是哪个键、按键怎么显示 */
export type KeyPlatform = 'mac' | 'windows' | 'linux';

export interface KeyActionSpec {
  label: string;
  scope: KeyScope;
  /** 默认键 */
  chord: string;
  /** 全局动作在输入框 / 文本框里也响应 */
  allowInInput?: boolean;
}

/** 动作表：顺序即设置页的顺序 */
const ACTIONS = {
  'new-session': { label: '新建会话', scope: 'global', chord: 'mod+n', allowInInput: true },
  'open-settings': { label: '打开设置', scope: 'global', chord: 'mod+,', allowInInput: true },
  'toggle-side-panel': {
    label: '切换右侧面板',
    scope: 'global',
    chord: 'mod+b',
    allowInInput: true,
  },
  'focus-composer': { label: '聚焦输入框', scope: 'global', chord: 'mod+l', allowInInput: true },
  'prev-session': {
    label: '上一个会话',
    scope: 'global',
    chord: 'mod+shift+[',
    allowInInput: true,
  },
  'next-session': {
    label: '下一个会话',
    scope: 'global',
    chord: 'mod+shift+]',
    allowInInput: true,
  },
  'search-sessions': { label: '搜索会话', scope: 'global', chord: 'mod+k', allowInInput: true },
  send: { label: '发送', scope: 'composer', chord: 'enter' },
  newline: { label: '换行', scope: 'composer', chord: 'shift+enter' },
  'cycle-approval': { label: '切换审批档位', scope: 'composer', chord: 'shift+tab' },
  'stop-turn': { label: '停止当前回合', scope: 'composer', chord: 'escape' },
  'open-model-picker': { label: '打开模型选择器', scope: 'composer', chord: 'mod+m' },
  'history-prev': { label: '上一条历史消息', scope: 'composer', chord: 'arrowup' },
  'history-next': { label: '下一条历史消息', scope: 'composer', chord: 'arrowdown' },
} satisfies Record<string, KeyActionSpec>;

export type ActionId = keyof typeof ACTIONS;
export const KEY_ACTIONS: Readonly<Record<ActionId, KeyActionSpec>> = ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];

/** settings.json 里的覆盖表：只存改过的动作 */
export type KeybindingOverrides = Partial<Record<ActionId, string>>;
/** 每个动作当前生效的按键串（已按平台展开 `mod`） */
export type ResolvedKeybindings = Record<ActionId, string>;

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && (ACTION_IDS as readonly string[]).includes(value);
}

/** `process.platform` → 按键平台 */
export function keyPlatformOf(platform: string): KeyPlatform {
  if (platform === 'darwin') return 'mac';
  return platform === 'win32' ? 'windows' : 'linux';
}

// ---------------------------------------------------------------------------
// 按键串的解析与规整

const MODIFIERS = ['mod', 'ctrl', 'alt', 'shift', 'meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

const NAMED_KEYS = new Set([
  'enter',
  'tab',
  'escape',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'plus',
]);

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '`', '-', '=']);

/** 键名别名（含 KeyboardEvent.key 的写法，小写后查） */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  ' ': 'space',
  spacebar: 'space',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  '+': 'plus',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
  backquote: '`',
  minus: '-',
  equal: '=',
};

const FUNCTION_KEY = /^f(?:[1-9]|1\d|2[0-4])$/;

/** 小写的键名 → 规整后的键；修饰键本身与认不出的键为 null */
function keyToken(raw: string): string | null {
  const token = KEY_ALIASES[raw] ?? raw;
  if (NAMED_KEYS.has(token) || PUNCTUATION.has(token)) return token;
  if (/^[a-z0-9]$/.test(token) || FUNCTION_KEY.test(token)) return token;
  return null;
}

interface Chord {
  mods: ReadonlySet<Modifier>;
  key: string;
}

function splitChord(text: string): string[] {
  if (text === '+') return ['plus'];
  // 末尾的「++」：最后一个键是加号
  if (text.endsWith('++')) return [...text.slice(0, -2).split('+'), 'plus'];
  return text.split('+');
}

function parseChord(input: string, platform?: KeyPlatform): Chord | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const parts = splitChord(text).map((part) => part.trim());
  const key = keyToken(parts.at(-1) ?? '');
  if (key === null) return null;
  const mods = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return null;
    mods.add(modifier === 'mod' && platform ? (platform === 'mac' ? 'meta' : 'ctrl') : modifier);
  }
  return { mods, key };
}

function serialize({ mods, key }: Chord): string {
  return [...MODIFIERS.filter((modifier) => mods.has(modifier)), key].join('+');
}

/**
 * 规整按键串：大小写、空白、修饰键顺序与别名（`Shift+Ctrl+K` → `ctrl+shift+k`，`cmd` → `meta`）。
 * 给了平台时把 `mod` 展开成 macOS 的 meta / 其他平台的 ctrl。认不出时返回 null。
 */
export function normalizeChord(input: string, platform?: KeyPlatform): string | null {
  const chord = parseChord(input, platform);
  return chord ? serialize(chord) : null;
}

/** keydown 事件需要的字段；React 的合成事件与 DOM KeyboardEvent 都满足 */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};
for (let digit = 0; digit <= 9; digit += 1) CODE_KEYS[`Digit${digit}`] = String(digit);
for (const letter of 'abcdefghijklmnopqrstuvwxyz') CODE_KEYS[`Key${letter.toUpperCase()}`] = letter;

function eventKey({ key, code, ctrlKey, altKey, metaKey }: KeyEventLike): string | null {
  const lower = key.toLowerCase();
  // 字母认键面：AZERTY 等布局按键帽上的字母
  if (/^[a-z]$/.test(lower)) return lower;
  // 数字与符号认物理位置：按着 Shift 时 key 会变（Ctrl+Shift+[ 的 key 是 {）；非拉丁字母也落到这里
  const physical = CODE_KEYS[code];
  if (physical) {
    // 输入法正在处理的键、死键：不带 Ctrl / Alt / Meta 时是在打字
    if ((lower === 'process' || lower === 'dead') && !(ctrlKey || altKey || metaKey)) return null;
    return physical;
  }
  return keyToken(lower);
}

/** keydown → 按键串。只按了修饰键、输入法组字中、AltGr 打字、认不出的键返回 null。 */
export function chordFromEvent(event: KeyEventLike): string | null {
  if (event.isComposing || event.getModifierState?.('AltGraph')) return null;
  const key = eventKey(event);
  if (key === null) return null;
  const mods = new Set<Modifier>();
  if (event.ctrlKey) mods.add('ctrl');
  if (event.altKey) mods.add('alt');
  if (event.shiftKey) mods.add('shift');
  if (event.metaKey) mods.add('meta');
  return serialize({ mods, key });
}

// ---------------------------------------------------------------------------
// 显示

const KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Esc',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  plus: '+',
};
const MAC_KEY_LABELS: Record<string, string> = {
  ...KEY_LABELS,
  enter: '↩',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
};
const MAC_MODIFIERS: Record<Modifier, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};

/** 显示用：macOS 符号连写（⌃⌥⇧⌘K），其他平台 `Ctrl+Alt+Shift+K`。认不出的串原样返回。 */
export function formatChord(chord: string, platform: KeyPlatform): string {
  const parsed = parseChord(chord, platform);
  if (!parsed) return chord;
  const present = MODIFIERS.filter((modifier) => parsed.mods.has(modifier));
  if (platform === 'mac') {
    const key = MAC_KEY_LABELS[parsed.key] ?? parsed.key.toUpperCase();
    return [...present.map((modifier) => MAC_MODIFIERS[modifier]), key].join('');
  }
  const names: Record<Modifier, string> = {
    mod: 'Ctrl',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: platform === 'windows' ? 'Win' : 'Super',
  };
  const key = KEY_LABELS[parsed.key] ?? parsed.key.toUpperCase();
  return [...present.map((modifier) => names[modifier]), key].join('+');
}

const ARIA_MODIFIERS: Record<Modifier, string> = {
  mod: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
};
const ARIA_KEYS: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  plus: 'Plus',
};

/** `aria-keyshortcuts` 的写法（`Control+Shift+K`）；认不出时为空串 */
export function toAriaKeyShortcuts(chord: string): string {
  const parsed = parseChord(chord);
  if (!parsed) return '';
  const present = MODIFIERS.filter((modifier) => parsed.mods.has(modifier));
  const key = ARIA_KEYS[parsed.key] ?? parsed.key.toUpperCase();
  return [...present.map((modifier) => ARIA_MODIFIERS[modifier]), key].join('+');
}

// ---------------------------------------------------------------------------
// 默认键、覆盖与冲突

export function defaultChord(action: ActionId, platform: KeyPlatform): string {
  const { chord } = KEY_ACTIONS[action];
  return normalizeChord(chord, platform) ?? chord;
}

/** 不带 Ctrl / Alt / Meta 也能绑的键（可加 Shift）：其余键单按是在打字或移动光标，绑上会吞掉输入 */
const COMPOSER_BARE_KEYS = new Set(['enter', 'tab', 'escape', 'arrowup', 'arrowdown']);

/** 这个键能不能绑给这个动作：要带 Ctrl / Alt / Meta，F 键与输入框动作的 Enter、Tab、Esc、↑、↓ 除外 */
export function isAllowedChord(action: ActionId, chord: string): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  const { mods, key } = parsed;
  if (mods.has('mod') || mods.has('ctrl') || mods.has('alt') || mods.has('meta')) return true;
  if (FUNCTION_KEY.test(key)) return true;
  return KEY_ACTIONS[action].scope === 'composer' && COMPOSER_BARE_KEYS.has(key);
}

/** 每个动作当前生效的键：覆盖项合法就用它（按平台展开），否则用默认键 */
export function resolveKeybindings(
  overrides: KeybindingOverrides | undefined,
  platform: KeyPlatform
): ResolvedKeybindings {
  const resolved = {} as ResolvedKeybindings;
  for (const action of ACTION_IDS) {
    const custom = overrides?.[action];
    const chord = custom === undefined ? null : normalizeChord(custom, platform);
    resolved[action] =
      chord !== null && isAllowedChord(action, chord) ? chord : defaultChord(action, platform);
  }
  return resolved;
}

/** 同一次按键会不会同时触发两个动作：同作用域；或全局动作在输入框里也响应（输入框动作会先截住它） */
export function scopesOverlap(a: KeyActionSpec, b: KeyActionSpec): boolean {
  if (a.scope === b.scope) return true;
  return (a.scope === 'global' ? a : b).allowInInput === true;
}

/** 编辑文本的键：绑给全局动作会在输入框里吞掉复制粘贴 */
const RESERVED_CHORDS: Record<string, string> = {
  'mod+a': '全选',
  'mod+c': '复制',
  'mod+v': '粘贴',
  'mod+x': '剪切',
  'mod+z': '撤销',
  'mod+shift+z': '重做',
  'mod+y': '重做',
};

export type KeyConflict = { action: ActionId } | { reserved: string };

/** 把 `chord` 绑给 `action` 会和谁冲突：保留的编辑键，或作用域重叠、键相同的其他动作 */
export function findConflict(
  action: ActionId,
  chord: string,
  bindings: ResolvedKeybindings,
  platform: KeyPlatform
): KeyConflict | null {
  for (const [reserved, label] of Object.entries(RESERVED_CHORDS)) {
    if (normalizeChord(reserved, platform) === chord) return { reserved: label };
  }
  const spec = KEY_ACTIONS[action];
  const other = ACTION_IDS.find(
    (id) => id !== action && bindings[id] === chord && scopesOverlap(spec, KEY_ACTIONS[id])
  );
  return other ? { action: other } : null;
}

export function conflictLabel(conflict: KeyConflict): string {
  return 'action' in conflict ? KEY_ACTIONS[conflict.action].label : conflict.reserved;
}

// ---------------------------------------------------------------------------
// settings 收窄

/** 一条覆盖项：已知动作 + 这个动作允许的键，返回规整后的键（`mod` 原样保留） */
function parseOverride(action: string, value: unknown): string | null {
  if (!isActionId(action) || typeof value !== 'string') return null;
  const chord = normalizeChord(value);
  return chord !== null && isAllowedChord(action, chord) ? chord : null;
}

/** settings.json 里的覆盖表（宽松）：逐条丢弃未知动作与不合法的键，一条不剩时返回 undefined */
export function parseKeybindingOverrides(raw: unknown): KeybindingOverrides | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const entries: [string, string][] = [];
  for (const [action, value] of Object.entries(record)) {
    const chord = parseOverride(action, value);
    if (chord !== null) entries.push([action, chord]);
  }
  // fromEntries 定义自有属性：键是 `__proto__` 也不会改到原型
  return entries.length > 0 ? (Object.fromEntries(entries) as KeybindingOverrides) : undefined;
}

/** `settings:update` 的 keybindings（严格）：任何一条不合法整个作废；空表合法（全部重置） */
export function parseKeybindingPatch(raw: unknown): KeybindingOverrides | null {
  const record = asRecord(raw);
  if (!record) return null;
  const entries: [string, string][] = [];
  for (const [action, value] of Object.entries(record)) {
    const chord = parseOverride(action, value);
    if (chord === null) return null;
    entries.push([action, chord]);
  }
  return Object.fromEntries(entries) as KeybindingOverrides;
}
