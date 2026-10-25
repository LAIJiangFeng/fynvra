import { type KeyEventLike, resolveKeybindings } from '@shared/keybindings';
import { describe, expect, it } from 'vitest';
import {
  type GlobalKeyEvent,
  globalActionOf,
  isEditableTarget,
  isInsideDialog,
  shouldRunGlobal,
  type TargetLike,
} from './scope';

/** 假的事件目标：`inside` 是它所在的祖先（role），closest 按选择器里的 role 匹配 */
function element(tagName: string, init: Partial<TargetLike> & { inside?: string[] } = {}) {
  const { inside = [], ...rest } = init;
  return {
    tagName,
    closest: (selector: string) =>
      inside.some((role) => selector.includes(`[role="${role}"]`)) ? {} : null,
    ...rest,
  } satisfies TargetLike;
}

const windows = resolveKeybindings(undefined, 'windows');

function keydown(
  init: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>,
  target: TargetLike | null = element('BODY'),
  defaultPrevented = false
): GlobalKeyEvent {
  return {
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target,
    defaultPrevented,
    ...init,
  };
}

describe('isEditableTarget', () => {
  it('文本输入框、文本框、下拉框、contenteditable 算在输入', () => {
    expect(isEditableTarget(element('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(element('INPUT'))).toBe(true);
    expect(isEditableTarget(element('input', { type: 'search' }))).toBe(true);
    expect(isEditableTarget(element('INPUT', { type: 'password' }))).toBe(true);
    expect(isEditableTarget(element('SELECT'))).toBe(true);
    expect(isEditableTarget(element('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('按钮、勾选框、单选框、滑块不算；空目标不算', () => {
    expect(isEditableTarget(element('BUTTON'))).toBe(false);
    expect(isEditableTarget(element('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(element('INPUT', { type: 'Radio' }))).toBe(false);
    expect(isEditableTarget(element('INPUT', { type: 'range' }))).toBe(false);
    expect(isEditableTarget(element('BODY'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});

describe('isInsideDialog', () => {
  it('在 role=dialog / alertdialog 里（弹窗、设置视图）', () => {
    expect(isInsideDialog(element('BUTTON', { inside: ['dialog'] }))).toBe(true);
    expect(isInsideDialog(element('BUTTON', { inside: ['alertdialog'] }))).toBe(true);
    expect(isInsideDialog(element('TEXTAREA', { inside: ['main'] }))).toBe(false);
    expect(isInsideDialog(null)).toBe(false);
    expect(isInsideDialog({})).toBe(false);
  });
});

describe('shouldRunGlobal', () => {
  it('弹窗里不响应', () => {
    expect(shouldRunGlobal('new-session', element('BUTTON', { inside: ['dialog'] }))).toBe(false);
  });

  it('输入框里只响应标了 allowInInput 的动作', () => {
    expect(shouldRunGlobal('new-session', element('TEXTAREA'))).toBe(true);
    // 输入框动作不该经全局监听派发
    expect(shouldRunGlobal('send', element('TEXTAREA'))).toBe(false);
    expect(shouldRunGlobal('send', element('BUTTON'))).toBe(true);
  });

  it('不在输入框、不在弹窗：响应', () => {
    expect(shouldRunGlobal('toggle-side-panel', element('BUTTON'))).toBe(true);
    expect(shouldRunGlobal('toggle-side-panel', null)).toBe(true);
  });
});

describe('globalActionOf（全局监听的作用域判断）', () => {
  it('默认键派发到对应的全局动作，在输入框里也一样', () => {
    expect(globalActionOf(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }), windows)).toBe(
      'new-session'
    );
    expect(
      globalActionOf(
        keydown({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
        windows
      )
    ).toBe('next-session');
    expect(
      globalActionOf(
        keydown({ key: 'k', code: 'KeyK', ctrlKey: true }, element('TEXTAREA')),
        windows
      )
    ).toBe('search-sessions');
  });

  it('输入框动作（Enter、Shift+Tab、Ctrl+M）不由全局监听派发', () => {
    expect(globalActionOf(keydown({ key: 'Enter', code: 'Enter' }), windows)).toBeNull();
    expect(
      globalActionOf(keydown({ key: 'Tab', code: 'Tab', shiftKey: true }), windows)
    ).toBeNull();
    expect(globalActionOf(keydown({ key: 'm', code: 'KeyM', ctrlKey: true }), windows)).toBeNull();
  });

  it('组件已经处理过（preventDefault）、在弹窗里、没绑定的键：不派发', () => {
    const ctrlN = { key: 'n', code: 'KeyN', ctrlKey: true };
    expect(globalActionOf(keydown(ctrlN, element('BODY'), true), windows)).toBeNull();
    expect(
      globalActionOf(keydown(ctrlN, element('INPUT', { inside: ['dialog'] })), windows)
    ).toBeNull();
    expect(globalActionOf(keydown({ key: 'j', code: 'KeyJ', ctrlKey: true }), windows)).toBeNull();
    expect(
      globalActionOf(keydown({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), windows)
    ).toBeNull();
  });

  it('改键后按新键派发，旧键不再响应', () => {
    const custom = resolveKeybindings({ 'new-session': 'ctrl+alt+n' }, 'windows');
    expect(globalActionOf(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }), custom)).toBeNull();
    expect(
      globalActionOf(keydown({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }), custom)
    ).toBe('new-session');
  });

  it('macOS 上 ⌘ 是 mod，Ctrl+N 不是新建会话', () => {
    const mac = resolveKeybindings(undefined, 'mac');
    expect(globalActionOf(keydown({ key: 'n', code: 'KeyN', metaKey: true }), mac)).toBe(
      'new-session'
    );
    expect(globalActionOf(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }), mac)).toBeNull();
  });
});
