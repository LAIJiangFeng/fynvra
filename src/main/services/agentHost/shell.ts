import type { SettingsFile } from '../settingsFile';
import {
  availableShells,
  detectShell,
  resolveAgentShell,
  type ShellDetectionDeps,
  shellDetectionDeps,
} from '../shells';

export { detectShell, type ShellDetectionDeps } from '../shells';

export interface ShellPathResolverOptions extends Partial<ShellDetectionDeps> {
  settings: Pick<SettingsFile, 'read'>;
}

/** Legacy override wins. Re-read preferences for every spawn; cache only default Git detection. */
export function createShellPathResolver({
  settings,
  ...overrides
}: ShellPathResolverOptions): () => Promise<string | undefined> {
  const deps = shellDetectionDeps(overrides);
  let detected: Promise<string | undefined> | undefined;
  return async () => {
    const preferences = settings.read().preferences;
    if (preferences.shellPath) return preferences.shellPath;
    if (deps.platform !== 'win32') return undefined;
    let path: string | undefined;
    if (preferences.agentShell) {
      path = resolveAgentShell(preferences, await availableShells(deps), deps);
    } else {
      detected ??= detectShell(deps);
      path = await detected;
      // A cached executable may have been uninstalled since the last session.
      if (path && !deps.existsSync(path)) {
        detected = detectShell(deps);
        path = await detected;
      }
    }
    if (!path) {
      // Leaving shellPath undefined here would let pi auto-pick WSL's bash.exe.
      throw new Error(
        'No Git Bash found. Install Git for Windows or choose a Windows agent shell in Settings.'
      );
    }
    return path;
  };
}
