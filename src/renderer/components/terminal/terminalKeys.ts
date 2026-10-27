type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

/** null leaves the key with xterm, including Ctrl+C interrupts and IME input. */
export function terminalKeyAction(
  event: TerminalKeyEvent,
  isMac: boolean,
  hasSelection: boolean
): 'copy' | 'paste' | null {
  if (event.type !== 'keydown' || event.isComposing || event.altKey) return null;
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;

  const key = event.key.toLowerCase();
  if (key === 'v') return 'paste';
  if (key === 'c' && (isMac || event.shiftKey || hasSelection)) return 'copy';
  return null;
}
