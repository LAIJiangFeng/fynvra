import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import type { LogLevel } from '@shared/types/agent';
import type { SettingsFile } from '../settingsFile';

/** where.exe 的时限：PATH 上有连不上的网络盘时 where 会卡住，宁可退回固定位置 */
const WHERE_TIMEOUT_MS = 5_000;
/** Git for Windows 各架构的 mingw 目录：<root>\mingw64\bin\git.exe 等 */
const MINGW_DIRS = new Set(['mingw64', 'mingw32', 'clangarm64']);

const execFileAsync = promisify(execFile);

export interface ShellDetectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 运行命令（不经 shell）返回 stdout；非零退出、起不来或超时时 reject */
  exec(file: string, args: readonly string[]): Promise<string>;
  existsSync(path: string): boolean;
  log(level: LogLevel, message: string): void;
}

/**
 * worker 会话的 bash 工具该用哪个 shell。pi 在 Windows 上先找 `%ProgramFiles%\Git\bin\bash.exe`，
 * 再取 PATH 上第一个 bash.exe：Git 装在别处时那往往是 System32\bash.exe（WSL 启动器），
 * 而 WSL 的 git 读不懂 worktree 里 Windows 路径的 `gitdir:`，worker 提交会失败。
 *
 * Windows 上按顺序取第一个存在的 Git Bash：`where.exe git.exe` 第一个结果所在安装目录的 `bin\bash.exe`
 * → `%ProgramFiles%` → `%ProgramFiles(x86)%` → `%LOCALAPPDATA%\Programs` 下的 `Git\bin\bash.exe`；
 * 都没有时返回 undefined 并告警。非 Windows 返回 undefined（用 pi 默认）。
 */
export async function detectShell(deps: ShellDetectionDeps): Promise<string | undefined> {
  if (deps.platform !== 'win32') return undefined;
  const { env } = deps;
  const roots = [
    await gitRootOnPath(deps),
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
  ];
  // PATH 上的 Git 就装在 %ProgramFiles% 时同一个位置只查一次
  const candidates = [
    ...new Set(roots.flatMap((root) => (root ? [win32.join(root, 'bin', 'bash.exe')] : []))),
  ];
  const found = candidates.find((path) => deps.existsSync(path));
  if (found) {
    deps.log('info', `worker sessions run bash with ${found}`);
  } else {
    deps.log(
      'warn',
      `no Git Bash found (checked ${candidates.join(', ') || 'nothing'}); worker sessions use ` +
        "pi's own lookup, which may pick WSL's bash.exe from PATH. " +
        'Install Git for Windows or set preferences.shellPath in settings.json'
    );
  }
  return found;
}

/** PATH 上第一个 git.exe 所在的 Git for Windows 安装目录；git 不在 PATH 上或不是已知布局时 undefined */
async function gitRootOnPath(deps: ShellDetectionDeps): Promise<string | undefined> {
  // 用 System32 里的 where.exe：只给文件名时 Windows 会先在当前目录里找可执行文件
  const where = win32.join(deps.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  let stdout: string;
  try {
    stdout = await deps.exec(where, ['git.exe']);
  } catch {
    // 找不到时 where 退出码为 1；起不来或超时同样退回固定位置
    return undefined;
  }
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? gitRootOf(first) : undefined;
}

/** git.exe 在安装目录里的位置：`<root>\cmd`、`<root>\bin` 或 `<root>\mingw64\bin`（其他架构同理） */
function gitRootOf(gitExe: string): string | undefined {
  const dir = win32.dirname(gitExe);
  const name = win32.basename(dir).toLowerCase();
  if (name === 'cmd') return win32.dirname(dir);
  if (name !== 'bin') return undefined;
  const parent = win32.dirname(dir);
  return MINGW_DIRS.has(win32.basename(parent).toLowerCase()) ? win32.dirname(parent) : parent;
}

export interface ShellPathResolverOptions extends Partial<ShellDetectionDeps> {
  settings: Pick<SettingsFile, 'read'>;
}

/**
 * spawn-session 的 shellPath：settings.json 里手写的 `preferences.shellPath` 优先（每次都读，读的是内存快照），
 * 否则用 detectShell 的结果。探测在第一次调用时进行，结果（包括没找到）在进程内缓存。
 */
export function createShellPathResolver({
  settings,
  ...overrides
}: ShellPathResolverOptions): () => Promise<string | undefined> {
  const deps: ShellDetectionDeps = {
    platform: process.platform,
    env: process.env,
    exec: async (file, args) => {
      const { stdout } = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        timeout: WHERE_TIMEOUT_MS,
        windowsHide: true,
      });
      return stdout;
    },
    existsSync,
    log: (level, message) => (level === 'info' ? console.log : console.warn)(`[shell] ${message}`),
    ...overrides,
  };
  let detected: Promise<string | undefined> | undefined;
  return () => {
    const override = settings.read().preferences.shellPath;
    if (override) return Promise.resolve(override);
    detected ??= detectShell(deps);
    return detected;
  };
}
