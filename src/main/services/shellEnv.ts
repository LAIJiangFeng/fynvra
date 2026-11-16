import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';

// Dock / Finder 启动的应用只拿到 launchd 的最小 PATH；从登录 shell 补齐，worker 的 bash 与 run_checks 继承它。
const TIMEOUT_MS = 5_000;
const START = '__FYNVRA_PATH_START__';
const END = '__FYNVRA_PATH_END__';

export interface ShellEnvDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable(path: string): boolean;
  /** Resolves stdout; rejects on spawn failure, timeout or non-zero exit. */
  exec(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string>;
  warn(message: string): void;
}

export function pickLoginShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean
): string {
  const shell = env.SHELL?.trim();
  if (shell && posix.isAbsolute(shell) && isExecutable(shell)) return shell;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export function extractMarked(output: string): string | undefined {
  const start = output.indexOf(START);
  if (start < 0) return undefined;
  const end = output.indexOf(END, start + START.length);
  return end < 0 ? undefined : output.slice(start + START.length, end);
}

export function mergePath(loginPath: string, currentPath: string | undefined): string {
  const entries = [...loginPath.split(':'), ...(currentPath ?? '').split(':')];
  return [...new Set(entries.filter((entry) => entry.trim() !== ''))].join(':');
}

function defaultDeps(): ShellEnvDeps {
  return {
    platform: process.platform,
    env: process.env,
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    exec: (file, args, env) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          file,
          [...args],
          { env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        );
        child.stdin?.end();
      }),
    warn: (message) => console.warn(`[shell-env] ${message}`),
  };
}

/** darwin / linux：把登录 shell 的 PATH 合并进 env.PATH。失败只记警告，PATH 不变。 */
export async function loadLoginShellPath(overrides: Partial<ShellEnvDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') return;
  const shell = pickLoginShell(deps.platform, deps.env, deps.isExecutable);
  try {
    const output = await deps.exec(
      shell,
      ['-ilc', `printf "%s%s%s" "${START}" "$PATH" "${END}"`],
      deps.env
    );
    const loginPath = extractMarked(output);
    if (loginPath === undefined) {
      deps.warn(`${shell} did not print PATH markers`);
      return;
    }
    deps.env.PATH = mergePath(loginPath, deps.env.PATH);
  } catch (error) {
    deps.warn(
      `reading PATH from ${shell} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
