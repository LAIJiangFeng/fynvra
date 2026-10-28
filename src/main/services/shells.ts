import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { LogLevel } from '@shared/types/agent';
import type {
  AvailableShell,
  AvailableShells,
  Preferences,
  ShellKind,
  ShellPreference,
} from '@shared/types/settings';

const DETECTION_TIMEOUT_MS = 5_000;
const MINGW_DIRS = new Set(['mingw64', 'mingw32', 'clangarm64']);
const execFileAsync = promisify(execFile);

export interface ShellDetectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec(file: string, args: readonly string[]): Promise<string>;
  /** Production checks a regular file, plus execute permission on Unix. */
  existsSync(path: string): boolean;
  log(level: LogLevel, message: string): void;
}

export function shellDetectionDeps(
  overrides: Partial<ShellDetectionDeps> = {}
): ShellDetectionDeps {
  return {
    platform: process.platform,
    env: process.env,
    exec: async (file, args) => {
      const { stdout } = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        timeout: DETECTION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return stdout;
    },
    existsSync: (path) => {
      try {
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    log: (level, message) => (level === 'info' ? console.log : console.warn)(`[shell] ${message}`),
    ...overrides,
  };
}

/** Trusted where.exe, bounded even when PATH contains an unreachable network drive. */
async function whereExecutable(name: string, deps: ShellDetectionDeps): Promise<string[]> {
  const where = win32.join(deps.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  try {
    return (await deps.exec(where, [name]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readPowerShellJson(
  file: string,
  command: string,
  deps: ShellDetectionDeps
): Promise<unknown> {
  try {
    return JSON.parse(
      await deps.exec(file, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}`,
      ])
    );
  } catch {
    return undefined;
  }
}

async function detectPowerShell(deps: ShellDetectionDeps): Promise<string | undefined> {
  const candidates = [
    ...(await whereExecutable('pwsh.exe', deps)),
    deps.env.ProgramFiles && win32.join(deps.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
  ];
  const find = (paths: (string | undefined)[]) =>
    paths.find((path) => path && win32.isAbsolute(path) && deps.existsSync(path));
  const regular = find(candidates);
  if (regular) return regular;

  // App execution aliases can launch successfully while statSync fails with EACCES.
  // Resolve their installation instead of weakening the file check used at every spawn.
  const fromHomes = (homes: unknown[]) =>
    find(
      homes.map((home) =>
        typeof home === 'string' && win32.isAbsolute(home) && win32.parse(home).root.length > 1
          ? win32.join(home, 'pwsh.exe')
          : undefined
      )
    );
  const windowsPowerShell = defaultTerminalShell(deps).path;
  if (deps.existsSync(windowsPowerShell)) {
    const homes = await readPowerShellJson(
      windowsPowerShell,
      'ConvertTo-Json -Compress -InputObject @(Get-AppxPackage -Name Microsoft.PowerShell ' +
        '-ErrorAction Stop | Select-Object -ExpandProperty InstallLocation)',
      deps
    );
    const installed = Array.isArray(homes) ? fromHomes(homes) : undefined;
    if (installed) return installed;
  }

  const local = deps.env.LOCALAPPDATA;
  if (!local || !win32.isAbsolute(local) || win32.parse(local).root.length <= 1) return undefined;
  return fromHomes([
    await readPowerShellJson(
      win32.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      'if ($PSVersionTable.PSVersion.Major -ge 7) { ConvertTo-Json -Compress -InputObject $PSHOME }',
      deps
    ),
  ]);
}

function gitRootOf(gitExe: string): string | undefined {
  if (!win32.isAbsolute(gitExe)) return undefined;
  const dir = win32.dirname(gitExe);
  const name = win32.basename(dir).toLowerCase();
  if (name === 'cmd') return win32.dirname(dir);
  if (name !== 'bin') return undefined;
  const parent = win32.dirname(dir);
  return MINGW_DIRS.has(win32.basename(parent).toLowerCase()) ? win32.dirname(parent) : parent;
}

/** Git for Windows only: never search for bash.exe on PATH (it may be the WSL launcher). */
export async function detectShell(deps: ShellDetectionDeps): Promise<string | undefined> {
  if (deps.platform !== 'win32') return undefined;
  const { env } = deps;
  const git = (await whereExecutable('git.exe', deps))[0];
  const roots = [
    git && gitRootOf(git),
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
  ];
  const candidates = [
    ...new Set(roots.flatMap((root) => (root ? [win32.join(root, 'bin', 'bash.exe')] : []))),
  ];
  const found = candidates.find((path) => win32.isAbsolute(path) && deps.existsSync(path));
  if (found) {
    deps.log('info', `worker sessions run bash with ${found}`);
  } else {
    deps.log(
      'warn',
      `no Git Bash found (checked ${candidates.join(', ') || 'nothing'}); ` +
        'select a Windows agent shell in Settings or set preferences.shellPath in settings.json'
    );
  }
  return found;
}

export function defaultTerminalShell(deps: ShellDetectionDeps): { path: string; args: string[] } {
  return deps.platform === 'win32'
    ? {
        path: win32.join(
          deps.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        args: ['-NoLogo', '-NoProfile'],
      }
    : { path: deps.env.SHELL || '/bin/sh', args: ['-l'] };
}

/** Return stable ids and absolute executable paths; no commands come from Renderer. */
export async function availableShells(deps: ShellDetectionDeps): Promise<AvailableShell[]> {
  const shells: AvailableShell[] = [];
  const paths = deps.platform === 'win32' ? win32 : posix;
  const add = (
    id: ShellKind,
    label: string,
    candidates: (string | undefined)[],
    agentSupported: boolean
  ) => {
    const path = candidates.find(
      (candidate) => candidate && paths.isAbsolute(candidate) && deps.existsSync(candidate)
    );
    if (path) shells.push({ id, label, path, agentSupported });
  };
  if (deps.platform !== 'win32') {
    add('login', 'Login shell', [deps.env.SHELL], false);
    for (const id of ['bash', 'zsh', 'sh'] as const) add(id, id, [`/bin/${id}`], true);
    return shells;
  }
  const [pwsh, bash] = await Promise.all([
    detectPowerShell(deps),
    detectShell({ ...deps, log: () => {} }),
  ]);
  const system32 = win32.join(deps.env.SystemRoot || 'C:\\Windows', 'System32');
  add('pwsh', 'PowerShell 7', [pwsh], true);
  add('powershell', 'Windows PowerShell 5.1', [defaultTerminalShell(deps).path], true);
  add('cmd', 'cmd', [deps.env.ComSpec, win32.join(system32, 'cmd.exe')], false);
  add('git-bash', 'Git Bash', [bash], true);
  add('wsl', 'WSL', [win32.join(system32, 'wsl.exe')], false);
  return shells;
}

/** pi's shellPath uses -c. Reject known incompatible launchers even when entered as custom. */
export function supportsAgentPath(path: string): boolean {
  const name = win32.basename(path).toLowerCase();
  return (
    !['cmd', 'cmd.exe', 'wsl', 'wsl.exe'].includes(name) &&
    !/[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(path)
  );
}

export function validShellPreference(
  preference: ShellPreference | undefined,
  agent: boolean,
  deps: ShellDetectionDeps
): boolean {
  if (!preference) return true;
  if (agent && ['cmd', 'wsl', 'login'].includes(preference.kind)) return false;
  if (preference.kind !== 'custom') return true;
  const paths = deps.platform === 'win32' ? win32 : posix;
  return paths.isAbsolute(preference.path) && (!agent || supportsAgentPath(preference.path));
}

function selectedPath(
  preference: ShellPreference | undefined,
  shells: AvailableShell[],
  deps: ShellDetectionDeps,
  agent: boolean
): string | undefined {
  if (!preference || !validShellPreference(preference, agent, deps)) return undefined;
  const path =
    preference.kind === 'custom'
      ? preference.path
      : shells.find((shell) => shell.id === preference.kind && (!agent || shell.agentSupported))
          ?.path;
  return path && deps.existsSync(path) ? path : undefined;
}

export function resolveAgentShell(
  preferences: Pick<Preferences, 'shellPath' | 'agentShell'>,
  shells: AvailableShell[],
  deps: ShellDetectionDeps
): string | undefined {
  if (preferences.shellPath) return preferences.shellPath;
  if (deps.platform !== 'win32') return undefined;
  return (
    selectedPath(preferences.agentShell, shells, deps, true) ??
    selectedPath({ kind: 'git-bash' }, shells, deps, true) ??
    selectedPath({ kind: 'powershell' }, shells, deps, true) ??
    selectedPath({ kind: 'pwsh' }, shells, deps, true)
  );
}

/** Explicit PowerShell selections load profiles; only the historical default uses -NoProfile. */
export function resolveTerminalShell(
  preference: ShellPreference | undefined,
  shells: AvailableShell[],
  deps: ShellDetectionDeps
): { path: string; args: string[] } {
  const path = selectedPath(preference, shells, deps, false);
  if (!path || !preference) return defaultTerminalShell(deps);
  switch (preference.kind) {
    case 'pwsh':
    case 'powershell':
      return { path, args: ['-NoLogo'] };
    case 'git-bash':
      return { path, args: ['--login', '-i'] };
    case 'login':
    case 'bash':
    case 'zsh':
    case 'sh':
      return { path, args: ['-l'] };
    default:
      return { path, args: [] };
  }
}

export async function describeShells(
  preferences: Preferences,
  deps = shellDetectionDeps()
): Promise<AvailableShells> {
  const shells = await availableShells(deps);
  return {
    shells,
    defaultAgentPath: resolveAgentShell({}, shells, deps),
    defaultTerminalPath: defaultTerminalShell(deps).path,
    agentPath: resolveAgentShell(preferences, shells, deps),
    terminalPath: resolveTerminalShell(preferences.terminalShell, shells, deps).path,
  };
}
