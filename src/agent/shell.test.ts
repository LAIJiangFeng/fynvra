import { describe, expect, it } from 'vitest';
import { createSessionSettings } from './shell';

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
