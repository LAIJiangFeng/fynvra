import type { Input, WebContents } from 'electron';

const STEP = 0.5;
const MIN_LEVEL = -3;
const MAX_LEVEL = 5;

/** 返回新的缩放级别；不是缩放快捷键时返回 null。 */
export function zoomLevelFor(
  input: Input,
  level: number,
  platform = process.platform
): number | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (!(platform === 'darwin' ? input.meta : input.control)) return null;
  let next: number;
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') next = level + STEP;
  else if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract')
    next = level - STEP;
  else if (input.key === '0' || input.code === 'Numpad0') next = 0;
  else return null;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, next));
}

/**
 * 在 Main 直接处理 Mod+= / Mod+- / Mod+0：Electron 默认菜单的 zoomOut 加速键
 * (CmdOrCtrl+-) 在 macOS 上不可靠，只剩放大能用；这里接管并阻止默认菜单重复生效。
 */
export function registerZoomShortcuts(webContents: WebContents): void {
  webContents.on('before-input-event', (event, input) => {
    const next = zoomLevelFor(input, webContents.getZoomLevel());
    if (next === null) return;
    event.preventDefault();
    webContents.setZoomLevel(next);
  });
}
