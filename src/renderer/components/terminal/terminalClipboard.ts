import type { Terminal } from '@xterm/xterm';
import { translate } from '../../i18n';
import { terminalKeyAction } from './terminalKeys';

type ClipboardTerminal = Pick<
  Terminal,
  'attachCustomKeyEventHandler' | 'hasSelection' | 'getSelection' | 'clearSelection' | 'paste'
>;

export function attachTerminalClipboard(
  terminal: ClipboardTerminal,
  {
    isMac,
    isAlive,
    onError,
  }: { isMac: boolean; isAlive(): boolean; onError(message: string): void }
) {
  const copySelection = async () => {
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection);
      // A slow clipboard write must not clear a newer selection or touch a closed tab.
      if (isAlive() && terminal.getSelection() === selection) terminal.clearSelection();
    } catch {
      onError(translate('terminals.copyFailed'));
    }
  };
  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (isAlive()) terminal.paste(text);
    } catch {
      onError(translate('terminals.pasteFailed'));
    }
  };

  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalKeyAction(event, isMac, terminal.hasSelection());
    if (!action) return true;
    // Cancel the browser's native copy/paste as well as xterm's key handling.
    event.preventDefault();
    if (action === 'copy') void copySelection();
    else void pasteClipboard();
    return false;
  });

  return { copySelection, pasteClipboard };
}
