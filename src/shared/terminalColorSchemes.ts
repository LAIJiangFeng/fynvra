/**
 * 内嵌终端的配色方案（纯数据）。Main 的设置校验与 Renderer 共用 {@link TERMINAL_COLOR_SCHEME_IDS}。
 *
 * 颜色的形状同 xterm.js 的 `ITheme`。`fynvra` 是此前写死的终端配色；其余方案的颜色取自
 * mbadolato/iTerm2-Color-Schemes（MIT 许可，https://github.com/mbadolato/iTerm2-Color-Schemes）
 * 的 ghostty 导出，各方案上方注明对应的文件名。
 */

export const TERMINAL_COLOR_SCHEME_IDS = [
  'fynvra',
  '0x96f',
  'dracula',
  'one-dark',
  'nord',
  'gruvbox-dark',
  'tokyo-night',
  'catppuccin-mocha',
  'solarized-dark',
  'solarized-light',
  'github-light',
] as const;
export type TerminalColorSchemeId = (typeof TERMINAL_COLOR_SCHEME_IDS)[number];

export const DEFAULT_TERMINAL_COLOR_SCHEME: TerminalColorSchemeId = 'fynvra';

export function isTerminalColorSchemeId(value: unknown): value is TerminalColorSchemeId {
  return (
    typeof value === 'string' && (TERMINAL_COLOR_SCHEME_IDS as readonly string[]).includes(value)
  );
}

/** ANSI 之外的颜色 */
interface BaseColors {
  foreground: string;
  background: string;
  cursor: string;
  /** 块状光标盖住的文字颜色 */
  cursorAccent: string;
  selectionBackground: string;
  /** 选区里的文字颜色；缺省时保留文字原来的颜色 */
  selectionForeground?: string;
}

/** 与 xterm.js 的 `ITheme` 同形（只用到这些字段） */
export interface TerminalColors extends BaseColors {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalColorScheme {
  id: TerminalColorSchemeId;
  /** 显示名：方案的专有名称，不翻译 */
  name: string;
  colors: Readonly<TerminalColors>;
}

/** ANSI 0–7 或 8–15，顺序为 black red green yellow blue magenta cyan white */
type Ansi8 = readonly [string, string, string, string, string, string, string, string];

function scheme(
  name: string,
  base: BaseColors,
  normal: Ansi8,
  bright: Ansi8
): Omit<TerminalColorScheme, 'id'> {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal;
  const [
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = bright;
  return {
    name,
    colors: Object.freeze({
      ...base,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite,
    }),
  };
}

const SCHEMES: Record<TerminalColorSchemeId, Omit<TerminalColorScheme, 'id'>> = {
  // 此前写死的配色：xterm.js 没给值的光标文字、选区与 ANSI 色都是它的默认值
  fynvra: scheme(
    'Fynvra',
    {
      foreground: '#e4e4e7',
      background: '#18181b',
      cursor: '#e4e4e7',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255, 255, 255, 0.3)',
    },
    ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf'],
    ['#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
  ),
  // ghostty/0x96f
  '0x96f': scheme(
    '0x96f',
    {
      foreground: '#fcfcfa',
      background: '#262427',
      cursor: '#fcfcfa',
      cursorAccent: '#000000',
      selectionBackground: '#fcfcfa',
      selectionForeground: '#262427',
    },
    ['#262427', '#ff666d', '#b3e03a', '#ffc739', '#00cde8', '#a392e8', '#9deaf6', '#fcfcfa'],
    ['#545452', '#ff7e83', '#bee55e', '#ffd05e', '#1bd5eb', '#b0a3eb', '#acedf8', '#fcfcfa']
  ),
  // ghostty/Dracula
  dracula: scheme(
    'Dracula',
    {
      foreground: '#f8f8f2',
      background: '#282a36',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      selectionForeground: '#ffffff',
    },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']
  ),
  // ghostty/Atom One Dark
  'one-dark': scheme(
    'One Dark',
    {
      foreground: '#abb2bf',
      background: '#21252b',
      cursor: '#abb2bf',
      cursorAccent: '#21252b',
      selectionBackground: '#323844',
      selectionForeground: '#abb2bf',
    },
    ['#21252b', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#767676', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf']
  ),
  // ghostty/Nord
  nord: scheme(
    'Nord',
    {
      foreground: '#d8dee9',
      background: '#2e3440',
      cursor: '#eceff4',
      cursorAccent: '#282828',
      selectionBackground: '#eceff4',
      selectionForeground: '#4c566a',
    },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#596377', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']
  ),
  // ghostty/Gruvbox Dark
  'gruvbox-dark': scheme(
    'Gruvbox Dark',
    {
      foreground: '#ebdbb2',
      background: '#282828',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#665c54',
      selectionForeground: '#ebdbb2',
    },
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']
  ),
  // ghostty/TokyoNight
  'tokyo-night': scheme(
    'Tokyo Night',
    {
      foreground: '#c0caf5',
      background: '#1a1b26',
      cursor: '#c0caf5',
      cursorAccent: '#15161e',
      selectionBackground: '#33467c',
      selectionForeground: '#c0caf5',
    },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
    ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']
  ),
  // ghostty/Catppuccin Mocha
  'catppuccin-mocha': scheme(
    'Catppuccin Mocha',
    {
      foreground: '#cdd6f4',
      background: '#1e1e2e',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#f5e0dc',
      selectionForeground: '#1e1e2e',
    },
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    ['#585b70', '#f7aec2', '#c2ecbf', '#fcd682', '#aeccfc', '#f398da', '#b1eae1', '#a6adc8']
  ),
  // ghostty/iTerm2 Solarized Dark
  'solarized-dark': scheme(
    'Solarized Dark',
    {
      foreground: '#839496',
      background: '#002b36',
      cursor: '#839496',
      cursorAccent: '#073642',
      selectionBackground: '#073642',
      selectionForeground: '#93a1a1',
    },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#335e69', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']
  ),
  // ghostty/iTerm2 Solarized Light
  'solarized-light': scheme(
    'Solarized Light',
    {
      foreground: '#657b83',
      background: '#fdf6e3',
      cursor: '#657b83',
      cursorAccent: '#eee8d5',
      selectionBackground: '#eee8d5',
      selectionForeground: '#586e75',
    },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#bbb5a2'],
    ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']
  ),
  // ghostty/GitHub Light Default
  'github-light': scheme(
    'GitHub Light',
    {
      foreground: '#1f2328',
      background: '#ffffff',
      cursor: '#0969da',
      cursorAccent: '#3c9cff',
      selectionBackground: '#1f2328',
      selectionForeground: '#ffffff',
    },
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']
  ),
};

/** 设置页下拉的顺序即 {@link TERMINAL_COLOR_SCHEME_IDS} 的顺序 */
export const TERMINAL_COLOR_SCHEMES: readonly TerminalColorScheme[] = Object.freeze(
  TERMINAL_COLOR_SCHEME_IDS.map((id) => Object.freeze({ id, ...SCHEMES[id] }))
);

/** 生效的方案：不认识的 id 用默认方案 */
export function terminalColorSchemeOf(id: unknown): TerminalColorScheme {
  const resolved = isTerminalColorSchemeId(id) ? id : DEFAULT_TERMINAL_COLOR_SCHEME;
  return TERMINAL_COLOR_SCHEMES[TERMINAL_COLOR_SCHEME_IDS.indexOf(resolved)];
}
