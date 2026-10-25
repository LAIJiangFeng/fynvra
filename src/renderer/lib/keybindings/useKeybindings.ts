import { type ActionId, chordFromEvent, formatChord, type KeyEventLike } from '@shared/keybindings';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useKeybindingsStore } from '@/stores/settings';
import { browserInsertsNewline, composerHints } from './composer';
import { runAction } from './handlers';
import { KEY_PLATFORM } from './platform';
import { globalActionOf } from './scope';

/**
 * 全局快捷键的监听：挂在 window 的冒泡阶段，组件自己处理过（preventDefault）的按键不再派发；
 * 作用域判断见 {@link globalActionOf}。没有组件处理这个动作时不拦截按键。
 */
export function useKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = globalActionOf(event, useKeybindingsStore.getState().bindings);
      if (action && runAction(action)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** 输入框作用域的派发：这次按键是不是这个动作。按当前生效的键判断，改键后立即生效 */
export function matchAction(event: KeyEventLike, action: ActionId): boolean {
  return chordFromEvent(event) === useKeybindingsStore.getState().bindings[action];
}

/**
 * 「换行」动作：浏览器自己会换行时交给它；否则（如改成了 Ctrl+Enter）自己插入一个换行。
 * execCommand 走原生编辑：撤销照样能用，也会触发 React 的 onChange。
 */
export function insertNewline(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
  if (browserInsertsNewline(event)) return;
  event.preventDefault();
  document.execCommand('insertText', false, '\n');
}

/** 动作当前生效的键，按平台显示（Ctrl+B / ⌘B），改键后跟着变 */
export function useChordLabel(action: ActionId): string {
  const chord = useKeybindingsStore((state) => state.bindings[action]);
  return formatChord(chord, KEY_PLATFORM);
}

/** 输入框的悬停提示与 aria-keyshortcuts，改键、换语言后跟着变 */
export function useComposerHints(): { title: string; ariaKeyShortcuts: string } {
  const bindings = useKeybindingsStore((state) => state.bindings);
  const t = useT();
  return useMemo(() => composerHints(bindings, KEY_PLATFORM, t), [bindings, t]);
}
