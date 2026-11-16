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
      compaction: { enabled: false },
    });
  });

  it('leaves the shell to pi and disables native compaction for the default Magic policy', () => {
    const settings = createSessionSettings(undefined);
    expect(settings.getShellPath()).toBeUndefined();
    expect(settings.getEnableInstallTelemetry()).toBe(false);
    expect(settings.getGlobalSettings()).toEqual({
      enableInstallTelemetry: false,
      compaction: { enabled: false },
    });
  });

  const model = (id: string, contextWindow: number) => ({ provider: 'p', id, contextWindow });
  const threshold = (
    settings: ReturnType<typeof createSessionSettings>,
    m: ReturnType<typeof model>
  ) => m.contextWindow - settings.getCompactionSettings(m).reserveTokens;

  it('caps the native threshold at the configured token count', () => {
    const settings = createSessionSettings(undefined, 'native', 200_000);
    expect(threshold(settings, model('big', 1_000_000))).toBe(200_000);
    expect(settings.getCompactionSettings(model('big', 1_000_000)).enabled).toBe(true);
  });

  it('never raises the threshold above the default window minus reserve', () => {
    const settings = createSessionSettings(undefined, 'native', 300_000);
    expect(threshold(settings, model('mid', 272_000))).toBe(255_616);
  });

  it('recomputes for the current model after a switch to a smaller window', () => {
    const settings = createSessionSettings(undefined, 'native', 200_000);
    expect(threshold(settings, model('big', 1_000_000))).toBe(200_000);
    expect(threshold(settings, model('small', 128_000))).toBe(128_000 - 16_384);
    expect(threshold(settings, model('mid', 400_000))).toBe(200_000);
  });

  it('keeps the default reserve without a threshold', () => {
    const settings = createSessionSettings(undefined, 'native');
    expect(threshold(settings, model('big', 1_000_000))).toBe(1_000_000 - 16_384);
    expect(threshold(settings, model('mid', 272_000))).toBe(255_616);
  });
});
