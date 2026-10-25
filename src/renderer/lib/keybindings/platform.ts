import { keyPlatformOf } from '@shared/keybindings';

/** 本机的按键平台：mod 是 ⌘ 还是 Ctrl、按键怎么显示 */
export const KEY_PLATFORM = keyPlatformOf(window.fynvra.window.platform);
