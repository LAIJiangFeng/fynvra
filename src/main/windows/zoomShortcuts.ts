import {
  type ActionId,
  chordFromEvent,
  defaultChord,
  type KeybindingOverrides,
  keyPlatformOf,
  resolveKeybindings,
} from '@shared/keybindings';
import type { Input, WebContents } from 'electron';

const STEP = 0.5;
const MIN_LEVEL = -3;
const MAX_LEVEL = 5;

const ZOOM_ACTIONS = ['zoom-in', 'zoom-out', 'zoom-reset'] as const satisfies readonly ActionId[];
type ZoomAction = (typeof ZOOM_ACTIONS)[number];

/** 默认键的别名：Mod++（Shift+=）、Mod+_、小键盘加减与 0；只在动作仍用默认键时生效 */
function defaultZoomAlias(input: Input, platform: string): ZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (!(platform === 'darwin' ? input.meta : input.control)) return null;
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'zoom-in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'zoom-out';
  if (input.key === '0' || input.code === 'Numpad0') return 'zoom-reset';
  return null;
}

/** 这次按键是哪个缩放动作：先认当前生效的键，再认默认键的别名 */
export function zoomActionFor(
  input: Input,
  overrides: KeybindingOverrides | undefined,
  platform: string = process.platform
): ZoomAction | null {
  if (input.type !== 'keyDown') return null;
  const keyPlatform = keyPlatformOf(platform);
  const bindings = resolveKeybindings(overrides, keyPlatform);
  const chord = chordFromEvent({
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
    metaKey: input.meta,
  });
  const exact = ZOOM_ACTIONS.find((action) => bindings[action] === chord);
  if (exact) return exact;
  const alias = defaultZoomAlias(input, platform);
  return alias && bindings[alias] === defaultChord(alias, keyPlatform) ? alias : null;
}

/** 返回新的缩放级别；不是缩放快捷键时返回 null。 */
export function zoomLevelFor(
  input: Input,
  level: number,
  overrides?: KeybindingOverrides,
  platform: string = process.platform
): number | null {
  const action = zoomActionFor(input, overrides, platform);
  if (!action) return null;
  const next = action === 'zoom-in' ? level + STEP : action === 'zoom-out' ? level - STEP : 0;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, next));
}

/**
 * 在 Main 处理缩放快捷键（默认 Mod+= / Mod+- / Mod+0，可在设置里改）：Electron 默认菜单的
 * zoomOut 加速键 (CmdOrCtrl+-) 在 macOS 上不可靠；这里接管，并让默认菜单不再响应这几个键，
 * 改键后旧键也就不再缩放。`readOverrides` 每次按键现读（settings 有内存缓存），改键立即生效。
 */
export function registerZoomShortcuts(
  webContents: WebContents,
  readOverrides: () => KeybindingOverrides | undefined
): void {
  webContents.on('before-input-event', (event, input) => {
    webContents.setIgnoreMenuShortcuts(defaultZoomAlias(input, process.platform) !== null);
    const next = zoomLevelFor(input, webContents.getZoomLevel(), readOverrides());
    if (next === null) return;
    event.preventDefault();
    webContents.setZoomLevel(next);
  });
}
