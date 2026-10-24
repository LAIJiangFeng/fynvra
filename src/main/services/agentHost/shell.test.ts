import { parseSettings, type Settings } from '@shared/types/settings';
import { describe, expect, it, vi } from 'vitest';
import { createShellPathResolver, detectShell, type ShellDetectionDeps } from './shell';

const WHERE = 'C:\\WINDOWS\\System32\\where.exe';
const ENV = {
  SystemRoot: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};
const PROGRAM_FILES_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const PROGRAM_FILES_X86_BASH = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
const LOCAL_APP_DATA_BASH = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';

/** where.exe 的输出（null 表示 where 失败：git 不在 PATH 上时退出码 1）与磁盘上存在的文件 */
function probe(
  where: string | null,
  existing: string[],
  overrides: Partial<ShellDetectionDeps> = {}
) {
  const checked: string[] = [];
  const logs: string[] = [];
  const exec = vi.fn(async (_file: string, _args: readonly string[]) => {
    if (where === null) throw new Error('Command failed: where.exe git.exe');
    return where;
  });
  const deps: ShellDetectionDeps = {
    platform: 'win32',
    env: ENV,
    exec,
    existsSync: (path) => {
      checked.push(path);
      return existing.includes(path);
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  };
  return { deps, exec, checked, logs };
}

describe('detectShell', () => {
  it('leaves the shell to pi outside Windows without probing anything', async () => {
    const env = probe('/usr/bin/git\n', ['/bin/bash'], { platform: 'linux' });
    expect(await detectShell(env.deps)).toBeUndefined();
    expect(env.exec).not.toHaveBeenCalled();
    expect(env.checked).toEqual([]);
    expect(env.logs).toEqual([]);
  });

  it('takes the Git install of the first git.exe on PATH before the fixed locations', async () => {
    const env = probe('D:\\Software\\Git\\cmd\\git.exe\r\n', [
      'D:\\Software\\Git\\bin\\bash.exe',
      PROGRAM_FILES_BASH,
    ]);
    expect(await detectShell(env.deps)).toBe('D:\\Software\\Git\\bin\\bash.exe');
    // System32 里的 where.exe：只给文件名时 Windows 会先在当前目录找
    expect(env.exec).toHaveBeenCalledExactlyOnceWith(WHERE, ['git.exe']);
    expect(env.checked).toEqual(['D:\\Software\\Git\\bin\\bash.exe']);
    expect(env.logs).toEqual([
      'info: worker sessions run bash with D:\\Software\\Git\\bin\\bash.exe',
    ]);
  });

  it.each([
    ['cmd', 'D:\\Software\\Git\\cmd\\git.exe'],
    ['bin', 'D:\\Software\\Git\\bin\\git.exe'],
    ['mingw64\\bin（从 Git Bash 里启动时排在最前）', 'D:\\Software\\Git\\mingw64\\bin\\git.exe'],
    ['clangarm64\\bin（ARM64 版）', 'D:\\Software\\Git\\clangarm64\\bin\\git.exe'],
  ])('finds the install root from git.exe under %s', async (_layout, gitExe) => {
    const env = probe(`${gitExe}\r\n`, ['D:\\Software\\Git\\bin\\bash.exe']);
    expect(await detectShell(env.deps)).toBe('D:\\Software\\Git\\bin\\bash.exe');
  });

  it('only uses the first git.exe that where.exe prints', async () => {
    const env = probe('C:\\Tools\\Git\\cmd\\git.exe\r\nD:\\Software\\Git\\cmd\\git.exe\r\n', [
      'D:\\Software\\Git\\bin\\bash.exe',
    ]);
    expect(await detectShell(env.deps)).toBeUndefined();
    expect(env.checked).toEqual([
      'C:\\Tools\\Git\\bin\\bash.exe',
      PROGRAM_FILES_BASH,
      PROGRAM_FILES_X86_BASH,
      LOCAL_APP_DATA_BASH,
    ]);
  });

  it.each([
    ['%ProgramFiles%', [PROGRAM_FILES_BASH, PROGRAM_FILES_X86_BASH, LOCAL_APP_DATA_BASH]],
    ['%ProgramFiles(x86)%', [PROGRAM_FILES_X86_BASH, LOCAL_APP_DATA_BASH]],
    ['%LOCALAPPDATA%\\Programs', [LOCAL_APP_DATA_BASH]],
  ])(
    'falls back to Git Bash under %s when the PATH one has no bin\\bash.exe',
    async (_label, existing) => {
      const env = probe('D:\\Software\\Git\\cmd\\git.exe\r\n', existing);
      expect(await detectShell(env.deps)).toBe(existing[0]);
      expect(env.checked[0]).toBe('D:\\Software\\Git\\bin\\bash.exe');
    }
  );

  it('falls back to the fixed locations when git.exe is not on PATH', async () => {
    const env = probe(null, [LOCAL_APP_DATA_BASH]);
    expect(await detectShell(env.deps)).toBe(LOCAL_APP_DATA_BASH);
    expect(env.checked).toEqual([PROGRAM_FILES_BASH, PROGRAM_FILES_X86_BASH, LOCAL_APP_DATA_BASH]);
  });

  it('ignores a git.exe outside a Git for Windows layout, such as a package-manager shim', async () => {
    const env = probe('C:\\Users\\me\\scoop\\shims\\git.exe\r\n', [PROGRAM_FILES_BASH]);
    expect(await detectShell(env.deps)).toBe(PROGRAM_FILES_BASH);
    expect(env.checked).toEqual([PROGRAM_FILES_BASH]);
  });

  it('skips locations whose environment variable is not set', async () => {
    const env = probe(null, [LOCAL_APP_DATA_BASH], {
      env: { LOCALAPPDATA: ENV.LOCALAPPDATA },
    });
    expect(await detectShell(env.deps)).toBe(LOCAL_APP_DATA_BASH);
    expect(env.exec).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['git.exe']);
    expect(env.checked).toEqual([LOCAL_APP_DATA_BASH]);
  });

  it('returns undefined and warns with every location it checked when there is no Git Bash', async () => {
    const env = probe('C:\\Program Files\\Git\\cmd\\git.exe\r\n', []);
    expect(await detectShell(env.deps)).toBeUndefined();
    // PATH 上的安装就在 %ProgramFiles% 时只查一次
    expect(env.checked).toEqual([PROGRAM_FILES_BASH, PROGRAM_FILES_X86_BASH, LOCAL_APP_DATA_BASH]);
    expect(env.logs).toHaveLength(1);
    expect(env.logs[0]).toMatch(/^warn: no Git Bash found/);
    for (const path of env.checked) expect(env.logs[0]).toContain(path);
    expect(env.logs[0]).toContain('preferences.shellPath');
  });
});

describe('createShellPathResolver', () => {
  const settingsWith = (shellPath?: string): Settings =>
    parseSettings({ preferences: shellPath ? { shellPath } : {} });

  it('prefers preferences.shellPath from settings.json and then does not probe', async () => {
    const env = probe('D:\\Software\\Git\\cmd\\git.exe\r\n', ['D:\\Software\\Git\\bin\\bash.exe']);
    const resolve = createShellPathResolver({
      ...env.deps,
      settings: { read: () => settingsWith('C:\\msys64\\usr\\bin\\bash.exe') },
    });
    expect(await resolve()).toBe('C:\\msys64\\usr\\bin\\bash.exe');
    expect(env.exec).not.toHaveBeenCalled();
    expect(env.checked).toEqual([]);
  });

  it('detects once and reuses the result, warning only once', async () => {
    const env = probe(null, []);
    const resolve = createShellPathResolver({
      ...env.deps,
      settings: { read: () => settingsWith() },
    });
    expect(await Promise.all([resolve(), resolve()])).toEqual([undefined, undefined]);
    expect(await resolve()).toBeUndefined();
    expect(env.exec).toHaveBeenCalledTimes(1);
    expect(env.logs.filter((line) => line.startsWith('warn:'))).toHaveLength(1);
  });

  it('reads the override on every call, so a later edit wins over the cached detection', async () => {
    const env = probe('D:\\Software\\Git\\cmd\\git.exe\r\n', ['D:\\Software\\Git\\bin\\bash.exe']);
    let settings = settingsWith();
    const resolve = createShellPathResolver({ ...env.deps, settings: { read: () => settings } });
    expect(await resolve()).toBe('D:\\Software\\Git\\bin\\bash.exe');
    settings = settingsWith('C:\\msys64\\usr\\bin\\bash.exe');
    expect(await resolve()).toBe('C:\\msys64\\usr\\bin\\bash.exe');
    settings = settingsWith();
    expect(await resolve()).toBe('D:\\Software\\Git\\bin\\bash.exe');
    expect(env.exec).toHaveBeenCalledTimes(1);
  });
});
