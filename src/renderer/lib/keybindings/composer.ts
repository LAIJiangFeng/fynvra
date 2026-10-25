import {
  type ActionId,
  formatChord,
  type KeyPlatform,
  type ResolvedKeybindings,
  toAriaKeyShortcuts,
} from '@shared/keybindings';
import type { KeyboardEvent } from 'react';

/** 输入框的悬停提示，以及 aria-keyshortcuts（切换审批档位占了 Shift+Tab 的反向移焦点，要告诉读屏） */
export function composerHints(
  bindings: ResolvedKeybindings,
  platform: KeyPlatform
): { title: string; ariaKeyShortcuts: string } {
  const label = (action: ActionId) => formatChord(bindings[action], platform);
  return {
    title: `${label('send')} 发送，${label('newline')} 换行，${label('history-prev')} / ${label('history-next')} 翻历史消息`,
    ariaKeyShortcuts: toAriaKeyShortcuts(bindings['cycle-approval']),
  };
}

/** Enter / Shift+Enter 浏览器自己会在文本框里换行；带 Ctrl / Alt / Meta 或别的键不会 */
export function browserInsertsNewline(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  return event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/**
 * 「换行」动作：浏览器自己会换行时交给它；否则自己插入一个换行。
 * execCommand 走原生编辑：撤销照样能用，也会触发 React 的 onChange。
 */
export function insertNewline(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (browserInsertsNewline(event)) return;
  event.preventDefault();
  document.execCommand('insertText', false, '\n');
}
