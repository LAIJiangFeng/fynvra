import type { ActionId } from '@shared/keybindings';
import { useChordLabel } from './useKeybindings';

/** 悬停提示里跟在名称后面的快捷键，改键后跟着变 */
export function ShortcutHint({ action }: { action: ActionId }) {
  return <span className="ml-1.5 opacity-70">{useChordLabel(action)}</span>;
}
