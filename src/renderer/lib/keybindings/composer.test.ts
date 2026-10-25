import { resolveKeybindings } from '@shared/keybindings';
import { describe, expect, it } from 'vitest';
import { translatorOf } from '../../i18n';
import { browserInsertsNewline, composerHints } from './composer';

const zh = translatorOf('zh-CN');

describe('composerHints', () => {
  it('默认键：悬停提示与 aria-keyshortcuts（Shift+Tab 占了反向移焦点）', () => {
    expect(composerHints(resolveKeybindings(undefined, 'windows'), 'windows', zh)).toEqual({
      title: 'Enter 发送，Shift+Enter 换行，↑ / ↓ 翻历史消息',
      ariaKeyShortcuts: 'Shift+Tab',
    });
    expect(composerHints(resolveKeybindings(undefined, 'mac'), 'mac', zh).title).toBe(
      '↩ 发送，⇧↩ 换行，↑ / ↓ 翻历史消息'
    );
  });

  it('跟着改过的键变', () => {
    const bindings = resolveKeybindings(
      { send: 'ctrl+enter', newline: 'enter', 'cycle-approval': 'alt+a' },
      'windows'
    );
    expect(composerHints(bindings, 'windows', zh)).toEqual({
      title: 'Ctrl+Enter 发送，Enter 换行，↑ / ↓ 翻历史消息',
      ariaKeyShortcuts: 'Alt+A',
    });
  });

  it('按界面语言', () => {
    const hints = composerHints(
      resolveKeybindings(undefined, 'windows'),
      'windows',
      translatorOf('en')
    );
    expect(hints.title).toBe('Enter to send, Shift+Enter for a new line, ↑ / ↓ for history');
  });
});

describe('browserInsertsNewline', () => {
  const press = (init: {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  }) => ({
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  });

  it('Enter / Shift+Enter：浏览器自己换行（保留撤销栈）', () => {
    expect(browserInsertsNewline(press({ key: 'Enter' }))).toBe(true);
  });

  it('带 Ctrl / Alt / Meta 的 Enter 或别的键：浏览器不换行，要自己插入', () => {
    expect(browserInsertsNewline(press({ key: 'Enter', ctrlKey: true }))).toBe(false);
    expect(browserInsertsNewline(press({ key: 'Enter', altKey: true }))).toBe(false);
    expect(browserInsertsNewline(press({ key: 'Enter', metaKey: true }))).toBe(false);
    expect(browserInsertsNewline(press({ key: 'j', ctrlKey: true }))).toBe(false);
  });
});
