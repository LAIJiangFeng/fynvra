import { describe, expect, it } from 'vitest';
import { parsePreferences, parsePreferencesPatch, SHELL_KINDS } from './settings';

describe('shell preferences', () => {
  it.each(SHELL_KINDS)('parses terminal kind %s and restricts incompatible agent kinds', (kind) => {
    expect(parsePreferences({ terminalShell: { kind, path: '/ignored' } }).terminalShell).toEqual({
      kind,
    });
    const agent = parsePreferences({ agentShell: { kind } }).agentShell;
    if (['cmd', 'wsl', 'login'].includes(kind)) expect(agent).toBeUndefined();
    else expect(agent).toEqual({ kind });
  });

  it.each([
    '/bin/bash',
    'C:\\Tools\\pwsh.exe',
    'D:/Git/bin/bash.exe',
    '\\\\server\\share\\bash.exe',
  ])('keeps custom absolute path %s and strips extra fields', (path) => {
    const preference = { kind: 'custom', path };
    expect(
      parsePreferences({ agentShell: { ...preference, path: ` ${path} `, args: ['-c'] } })
        .agentShell
    ).toEqual(preference);
    expect(parsePreferencesPatch({ terminalShell: preference })).toEqual({
      terminalShell: preference,
    });
  });

  it.each([
    null,
    '',
    [],
    42,
    { kind: 'unknown' },
    { kind: 'custom' },
    { kind: 'custom', path: 'bash.exe' },
    { kind: 'custom', path: 'C:bash.exe' },
    { kind: 'custom', path: '\\bash.exe' },
    { kind: 'custom', path: '/bin/ba\0sh' },
    { kind: 'custom', path: 42 },
  ])('drops junk on disk and rejects invalid IPC patches: %j', (value) => {
    expect(parsePreferences({ agentShell: value, terminalShell: value })).not.toHaveProperty(
      'agentShell'
    );
    expect(parsePreferences({ terminalShell: value })).not.toHaveProperty('terminalShell');
    expect(parsePreferencesPatch({ agentShell: value })).toBeNull();
    expect(parsePreferencesPatch({ terminalShell: value })).toBeNull();
  });

  it('keeps both new preferences and legacy shellPath and supports explicit resets', () => {
    expect(
      parsePreferences({
        shellPath: 'C:\\legacy\\bash.exe',
        agentShell: { kind: 'pwsh' },
        terminalShell: { kind: 'cmd' },
      })
    ).toMatchObject({
      shellPath: 'C:\\legacy\\bash.exe',
      agentShell: { kind: 'pwsh' },
      terminalShell: { kind: 'cmd' },
    });
    const patch = parsePreferencesPatch({ agentShell: undefined, terminalShell: undefined });
    expect(patch).toEqual({ agentShell: undefined, terminalShell: undefined });
    expect(parsePreferences(patch)).not.toHaveProperty('agentShell');
    expect(parsePreferences(patch)).not.toHaveProperty('terminalShell');
    expect(parsePreferencesPatch({ shellPath: '/bin/bash' })).toBeNull();
    expect(parsePreferencesPatch({ agentShell: { kind: 'cmd' } })).toBeNull();
  });
});
