import type { ShellPreference } from '@shared/types/settings';
import type { SettingsFile } from '../settingsFile';
import {
  availableShells,
  resolveAgentShell,
  type ShellDetectionDeps,
  shellDetectionDeps,
} from '../shells';

export { detectShell, type ShellDetectionDeps } from '../shells';

export interface ShellPathResolverOptions extends Partial<ShellDetectionDeps> {
  settings: Pick<SettingsFile, 'read'>;
}

/** Legacy override wins. Re-read preferences for every spawn; cache only default detection. */
export function createShellPathResolver({
  settings,
  ...overrides
}: ShellPathResolverOptions): () => Promise<string | undefined> {
  const deps = shellDetectionDeps(overrides);
  let detected: Promise<string | undefined> | undefined;
  const detect = async (preference?: ShellPreference): Promise<string | undefined> => {
    const shells = await availableShells(deps);
    const path = resolveAgentShell({ agentShell: preference }, shells, deps);
    const requested =
      preference?.kind === 'custom'
        ? preference.path
        : shells.find((shell) => shell.id === preference?.kind)?.path;
    const resolved = shells.find((shell) => shell.path === path);
    if (path && path !== requested && (resolved?.id === 'powershell' || resolved?.id === 'pwsh')) {
      deps.log(
        'warn',
        `no Git Bash found; worker sessions fall back to ${resolved.label} at ${path}`
      );
    } else if (!path) {
      deps.log(
        'warn',
        'no usable Windows agent shell found (Git Bash, Windows PowerShell or PowerShell 7)'
      );
    }
    return path;
  };
  return async () => {
    const preferences = settings.read().preferences;
    if (preferences.shellPath) return preferences.shellPath;
    if (deps.platform !== 'win32') return undefined;
    let path: string | undefined;
    if (preferences.agentShell) {
      path = await detect(preferences.agentShell);
    } else {
      detected ??= detect();
      path = await detected;
      // A cached executable may have been uninstalled since the last session.
      if (path && !deps.existsSync(path)) {
        detected = detect();
        path = await detected;
      }
    }
    if (!path) {
      // Leaving shellPath undefined here would let pi auto-pick WSL's bash.exe.
      throw new Error(
        'No usable Windows agent shell found. Install Git Bash or PowerShell, or choose a custom agent shell in Settings.'
      );
    }
    return path;
  };
}
