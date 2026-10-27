import type { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalClipboard } from './terminalClipboard';

function setup() {
  const clipboard = {
    readText: vi.fn().mockResolvedValue('first\nsecond'),
    writeText: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('navigator', { clipboard });
  const terminal = {
    attachCustomKeyEventHandler: vi.fn<Terminal['attachCustomKeyEventHandler']>(),
    hasSelection: vi.fn(() => true),
    getSelection: vi.fn(() => 'selected output'),
    clearSelection: vi.fn(),
    paste: vi.fn(),
  };
  const isAlive = vi.fn(() => true);
  const onError = vi.fn();
  const actions = attachTerminalClipboard(terminal, { isMac: false, isAlive, onError });
  const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
  return { clipboard, terminal, isAlive, onError, handler, ...actions };
}

function keydown(key: string): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

afterEach(() => vi.unstubAllGlobals());

describe('terminal clipboard integration', () => {
  it('intercepts selection copy, clears it after success, and preserves bare Ctrl+C', async () => {
    const { handler, terminal, clipboard } = setup();
    const copy = keydown('c');
    expect(handler(copy)).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith('selected output');
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(terminal.clearSelection).toHaveBeenCalledOnce();

    terminal.hasSelection.mockReturnValue(false);
    const interrupt = keydown('c');
    expect(handler(interrupt)).toBe(true);
    expect(interrupt.preventDefault).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledOnce();
  });

  it('prevents native paste and passes clipboard text to xterm exactly once', async () => {
    const { handler, clipboard, terminal } = setup();
    const paste = keydown('v');
    expect(handler(paste)).toBe(false);
    expect(paste.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith('first\nsecond');
  });

  it('does not write an empty selection or clear a newer selection', async () => {
    const { copySelection, clipboard, terminal } = setup();
    terminal.getSelection.mockReturnValueOnce('');
    await copySelection();
    expect(clipboard.writeText).not.toHaveBeenCalled();

    const copying = copySelection();
    terminal.getSelection.mockReturnValue('new selection');
    await copying;
    expect(clipboard.writeText).toHaveBeenCalledWith('selected output');
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('does not touch a disposed terminal when clipboard operations finish', async () => {
    const { copySelection, pasteClipboard, terminal, isAlive } = setup();
    const copying = copySelection();
    const pasting = pasteClipboard();
    isAlive.mockReturnValue(false);
    await Promise.all([copying, pasting]);
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('reports clipboard failures and preserves the selection for another attempt', async () => {
    const { clipboard, copySelection, pasteClipboard, terminal, onError } = setup();
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    await copySelection();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();

    clipboard.readText.mockRejectedValueOnce(new Error('denied'));
    await pasteClipboard();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
