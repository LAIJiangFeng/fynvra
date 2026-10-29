import { describe, expect, it } from 'vitest';
import { parseWorkspaceUi, sanitizeTerminalScreen } from './workspaceUi';

const terminal = {
  kind: 'terminal',
  id: '00000000-0000-4000-8000-000000000001',
  number: 1,
};

describe('restored terminal screen safety', () => {
  it('removes every C0/C1 control except tab and newline, preserving Unicode text', () => {
    const controls = Array.from({ length: 160 }, (_, code) =>
      code < 32 || code >= 127 ? String.fromCharCode(code) : ''
    ).join('');
    const screen = `before${controls}中文😀after`;
    expect(sanitizeTerminalScreen(screen)).toBe('before\t\n中文😀after');
    expect(
      parseWorkspaceUi({ tabs: [{ ...terminal, screen }] }, 'workspace')?.tabs[1]
    ).toMatchObject({ ...terminal, screen: 'before\t\n中文😀after' });
  });

  it('strips terminal escape introducers and carriage returns from saved text', () => {
    const screen = '\u001b[31mred\u001b[0m\r\n\u009b2J\u001b]52;c;payload\u0007';
    expect(sanitizeTerminalScreen(screen)).toBe('[31mred[0m\n2J]52;c;payload');
  });
});
