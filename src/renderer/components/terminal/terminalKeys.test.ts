import { describe, expect, it } from 'vitest';
import { terminalKeyAction } from './terminalKeys';

function key(overrides: Partial<Parameters<typeof terminalKeyAction>[0]> = {}) {
  return {
    type: 'keydown',
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe('terminalKeyAction', () => {
  it('copies Ctrl+C only with a selection on Windows/Linux', () => {
    expect(terminalKeyAction(key({ ctrlKey: true }), false, true)).toBe('copy');
    expect(terminalKeyAction(key({ ctrlKey: true }), false, false)).toBeNull();
  });

  it.each([true, false])('reserves Ctrl+Shift+C with selection=%s', (selected) => {
    expect(
      terminalKeyAction(key({ key: 'C', ctrlKey: true, shiftKey: true }), false, selected)
    ).toBe('copy');
  });

  it.each([true, false])('pastes Ctrl+V with Shift=%s', (shiftKey) => {
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true, shiftKey }), false, false)).toBe(
      'paste'
    );
  });

  it.each([true, false])('reserves Cmd+C with selection=%s on macOS', (selected) => {
    expect(terminalKeyAction(key({ metaKey: true }), true, selected)).toBe('copy');
    expect(
      terminalKeyAction(key({ key: 'C', metaKey: true, shiftKey: true }), true, selected)
    ).toBe('copy');
    expect(terminalKeyAction(key({ ctrlKey: true }), true, selected)).toBeNull();
    expect(terminalKeyAction(key({ ctrlKey: true, shiftKey: true }), true, selected)).toBeNull();
  });

  it.each([true, false])('pastes Cmd+V with Shift=%s on macOS', (shiftKey) => {
    expect(terminalKeyAction(key({ key: 'v', metaKey: true, shiftKey }), true, false)).toBe(
      'paste'
    );
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true, shiftKey }), true, false)).toBeNull();
  });

  it.each(['keyup', 'keypress'])('ignores %s', (type) => {
    for (const isMac of [false, true]) {
      for (const letter of ['c', 'v']) {
        expect(
          terminalKeyAction(
            key({ type, key: letter, ctrlKey: !isMac, metaKey: isMac }),
            isMac,
            true
          )
        ).toBeNull();
      }
    }
  });

  it('leaves IME composition, AltGr, mixed modifiers and ordinary input with xterm', () => {
    for (const event of [
      key({ ctrlKey: true, isComposing: true }),
      key({ ctrlKey: true, altKey: true }),
      key({ ctrlKey: true, metaKey: true }),
      key({ key: 'v', ctrlKey: true, isComposing: true }),
      key({ key: 'v', ctrlKey: true, altKey: true }),
      key({ key: 'x', ctrlKey: true }),
      key({ key: 'Tab' }),
      key(),
    ]) {
      expect(terminalKeyAction(event, false, true)).toBeNull();
    }
    expect(terminalKeyAction(key({ metaKey: true }), false, true)).toBeNull();
    expect(terminalKeyAction(key({ metaKey: true, isComposing: true }), true, true)).toBeNull();
  });
});
