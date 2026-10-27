import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, posix, win32 } from 'node:path';
import type { OpenWithApp } from '@shared/types/settings';

export interface AppDetectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  executable(path: string): boolean;
  exec(file: string, args: string[]): Promise<string>;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const appDetectionDeps = (): AppDetectionDeps => ({
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  executable,
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: 1500, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        }
      );
    }),
});

/** Detect once per process, including negative results; concurrent callers share the same probe. */
export function createVsCodeDetector(deps: AppDetectionDeps) {
  let cached: Promise<string | undefined> | undefined;
  async function detect(): Promise<string | undefined> {
    if (deps.platform === 'darwin') {
      const app = '/Applications/Visual Studio Code.app';
      return deps.exists(app) ? app : undefined;
    }
    if (deps.platform === 'win32') {
      // code.cmd is only a locator: never execute a batch file or interpolate a shell command.
      const candidates: string[] = [];
      try {
        const output = await deps.exec('where.exe', ['code.cmd']);
        for (const line of output.split(/\r?\n/)) {
          const cmd = line.trim();
          if (win32.isAbsolute(cmd) && win32.basename(cmd).toLowerCase() === 'code.cmd') {
            candidates.push(win32.resolve(win32.dirname(cmd), '..', 'Code.exe'));
          }
        }
      } catch {
        // PATH lookup can time out or VS Code may not have been added to PATH.
      }
      for (const root of [deps.env.LOCALAPPDATA, deps.env.ProgramFiles]) {
        if (!root || !win32.isAbsolute(root)) continue;
        candidates.push(
          root === deps.env.LOCALAPPDATA
            ? win32.join(root, 'Programs', 'Microsoft VS Code', 'Code.exe')
            : win32.join(root, 'Microsoft VS Code', 'Code.exe')
        );
      }
      return candidates.find((path) => deps.executable(path));
    }
    for (const directory of (deps.env.PATH ?? '').split(':')) {
      if (!posix.isAbsolute(directory)) continue;
      const path = posix.join(directory, 'code');
      if (deps.executable(path)) return path;
    }
    return undefined;
  }
  return (refresh = false): Promise<string | undefined> => {
    if (!cached || refresh) cached = detect();
    return cached;
  };
}

export const detectVsCode = createVsCodeDetector(appDetectionDeps());

/** Native picker and saved settings are the only sources of custom executable paths. */
export function validCustomAppPath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  if (process.platform === 'win32' && extname(path).toLowerCase() !== '.exe') return false;
  if (process.platform === 'darwin' && path.toLowerCase().endsWith('.app')) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  return executable(path);
}

const pickedApps = new Map<string, { path: string; senderId: number }>();

export function rememberPickedApp(path: string, senderId: number): OpenWithApp {
  const id = `custom-${randomUUID()}`;
  // Only a handful of drafts are needed; abandoned picker results must not grow indefinitely.
  if (pickedApps.size >= 20) {
    const oldest = pickedApps.keys().next().value;
    if (oldest) pickedApps.delete(oldest);
  }
  pickedApps.set(id, { path, senderId });
  return { id, name: basename(path, extname(path)).slice(0, 100), path };
}

export function allowedOpenWithAppsUpdate(
  apps: OpenWithApp[],
  saved: OpenWithApp[],
  senderId: number
): boolean {
  return apps.every((app) => {
    if (saved.some((current) => current.id === app.id && current.path === app.path)) return true;
    const picked = pickedApps.get(app.id);
    return (
      picked?.senderId === senderId && picked.path === app.path && validCustomAppPath(app.path)
    );
  });
}

export function buildOpenWithLaunch(
  application: string,
  folder: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform === 'win32' && !application.toLowerCase().endsWith('.exe')) {
    throw new Error('Only .exe applications can be launched on Windows');
  }
  const bundle = platform === 'darwin' && application.toLowerCase().endsWith('.app');
  return {
    file: bundle ? '/usr/bin/open' : application,
    args: bundle ? ['-a', application, folder] : [folder],
    options: { detached: true, stdio: 'ignore' as const, shell: false as const },
  };
}

/** Report spawn errors; for app bundles also wait for Launch Services to accept the request. */
export async function launchApplication(
  application: string,
  folder: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const { file, args, options } = buildOpenWithLaunch(application, folder, platform);
  const launcher = platform === 'darwin' && application.toLowerCase().endsWith('.app');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, options);
    child.once('error', reject);
    if (launcher) {
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Application launcher exited with code ${code}`));
      });
    }
    child.once('spawn', () => {
      child.unref();
      if (!launcher) resolve();
    });
  });
}
