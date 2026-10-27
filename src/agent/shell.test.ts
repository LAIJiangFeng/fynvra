import { getBuiltinRole, type Role } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import { createSessionSettings, roleWithShellPrompt } from './shell';

const builtinWorker = () => getBuiltinRole('worker') as Role;

describe('shell prompt append', () => {
  it.each([
    ['C:\\PowerShell\\pwsh.exe', 'PowerShell 7', 'PowerShell syntax'],
    ['C:\\Windows\\powershell.EXE', 'Windows PowerShell 5.1', 'PowerShell syntax'],
    ['/bin/zsh', '/bin/zsh', "that shell's native syntax"],
  ])('describes %s while preserving the role prompt', (path, label, syntax) => {
    const role = { ...builtinWorker(), systemPrompt: 'Existing role instructions.' };
    const appended = roleWithShellPrompt(role, path);
    expect(appended.systemPrompt).toContain('Existing role instructions.\n\nOn this machine');
    expect(appended.systemPrompt).toContain(label);
    expect(appended.systemPrompt).toContain(`via -c; write ${syntax}.`);
    expect(role.systemPrompt).toBe('Existing role instructions.');
  });

  it('leaves bash and default prompts unchanged', () => {
    const role = builtinWorker();
    expect(roleWithShellPrompt(role, 'D:\\Git\\bin\\bash.exe')).toBe(role);
    expect(roleWithShellPrompt(role, undefined)).toBe(role);
  });
});

describe('createSessionSettings', () => {
  it('gives the bash tool the shell from the spawn spec', () => {
    const settings = createSessionSettings('D:\\Software\\Git\\bin\\bash.exe');
    expect(settings.getShellPath()).toBe('D:\\Software\\Git\\bin\\bash.exe');
    expect(settings.getGlobalSettings()).toEqual({
      enableInstallTelemetry: false,
      shellPath: 'D:\\Software\\Git\\bin\\bash.exe',
    });
  });

  it('leaves the shell to pi without one and otherwise matches the agent-runtime default', () => {
    const settings = createSessionSettings(undefined);
    expect(settings.getShellPath()).toBeUndefined();
    expect(settings.getEnableInstallTelemetry()).toBe(false);
    expect(settings.getGlobalSettings()).toEqual({ enableInstallTelemetry: false });
  });
});
