import {
  type ActionId,
  formatChord,
  type KeyPlatform,
  type ResolvedKeybindings,
  toAriaKeyShortcuts,
} from '@shared/keybindings';

// 输入框作用域的纯函数；用到 DOM 的派发见 ./useKeybindings

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
