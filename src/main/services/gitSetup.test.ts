import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitSetup,
  type ExecOptions,
  type GitSetupDeps,
  MINGIT_FILES,
  mingitSources,
  validateGitIdentity,
} from './gitSetup';

const ZIP = new TextEncoder().encode('fake zip');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

let userData: string;
const x64 = MINGIT_FILES.x64 as { sha256: string };
const realSha = x64.sha256;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'fynvra-git-'));
  // 测试用假压缩包的校验值替换写死的值
  x64.sha256 = ZIP_SHA;
});
afterEach(() => {
  x64.sha256 = realSha;
  rmSync(userData, { recursive: true, force: true });
});

function setup(overrides: Partial<GitSetupDeps> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' };
  const cmdDir = join(userData, 'git', 'MinGit-2.56.1-x64', 'cmd');
  const fetch = vi.fn(async (_url: string) => new Response(ZIP));
  const exec = vi.fn(
    async (file: string, args: readonly string[], options?: ExecOptions): Promise<string> => {
      if (file.endsWith('tar.exe')) {
        const dir = args[3] as string;
        mkdirSync(join(dir, 'cmd'), { recursive: true });
        writeFileSync(join(dir, 'cmd', 'git.exe'), '');
        return '';
      }
      if (file.endsWith('git.exe')) return 'git version 2.56.1.windows.1\n';
      if (file === 'git' && args[0] === '--version') {
        if (options?.env?.PATH?.includes(cmdDir)) return 'git version 2.56.1.windows.1\n';
        throw new Error('not found');
      }
      if (file === 'git') throw new Error('unset');
      return '';
    }
  );
  const deps: GitSetupDeps = {
    platform: 'win32',
    arch: 'x64',
    env,
    userDataPath: userData,
    fetch: fetch as unknown as GitSetupDeps['fetch'],
    exec,
    ...overrides,
  };
  return { git: createGitSetup(deps), env, fetch, exec, cmdDir };
}

describe('gitSetup', () => {
  it('按架构选文件；x64、arm64 之外报不支持', async () => {
    const arm = setup({ arch: 'arm64' });
    arm.fetch.mockResolvedValue(new Response('bad'));
    await expect(arm.git.install()).rejects.toThrow();
    expect(arm.fetch.mock.calls[0]?.[0]).toContain('MinGit-2.56.1-arm64.zip');
    const ia32 = setup({ arch: 'ia32' });
    await expect(ia32.git.install()).rejects.toThrow(/ia32/);
    expect(ia32.fetch).not.toHaveBeenCalled();
  });

  it('镜像失败后回退 GitHub，安装成功后 PATH 末尾追加 cmd 目录', async () => {
    const { git, fetch, env, cmdDir, exec } = setup();
    fetch.mockRejectedValueOnce(new Error('mirror down'));
    const result = await git.install();
    const sources = mingitSources('MinGit-2.56.1-64-bit.zip');
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(sources);
    expect(sources[1]).toMatch(/^https:\/\/github\.com\//);
    expect(env.PATH).toBe(`C:\\Windows;${cmdDir}`);
    expect(result.status).toMatchObject({ available: true, source: 'bundled' });
    expect(exec).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\tar.exe',
      expect.arrayContaining(['-xf']),
      expect.anything()
    );
    expect(existsSync(join(cmdDir, 'git.exe'))).toBe(true);
    // 临时文件与临时目录都已清理
    expect(readdirSync(join(userData, 'git'))).toEqual(['MinGit-2.56.1-x64']);
  });

  it('校验不过删临时文件换源，全部失败则报错且不解压', async () => {
    const { git, fetch, exec } = setup();
    fetch.mockImplementation(async () => new Response('tampered'));
    await expect(git.install()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.some(([file]) => file.endsWith('tar.exe'))).toBe(false);
    expect(readdirSync(join(userData, 'git'))).toEqual([]);
  });

  it('并发安装只跑一次', async () => {
    const { git, fetch } = setup();
    const [a, b] = await Promise.all([git.install(), git.install()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('启动注入：win32 支持的架构目录不存在也追加且不重复，其他不追加', () => {
    const { git, env, cmdDir } = setup();
    expect(existsSync(cmdDir)).toBe(false);
    git.injectBundledPath();
    git.injectBundledPath();
    expect(env.PATH).toBe(`C:\\Windows;${cmdDir}`);
    for (const overrides of [
      { platform: 'darwin' as const },
      { platform: 'linux' as const },
      { arch: 'ia32' },
    ]) {
      const other = setup(overrides);
      other.git.injectBundledPath();
      expect(other.env.PATH).toBe('C:\\Windows');
    }
  });

  it('身份校验拒绝空值、换行、超长、没有 @ 的邮箱', () => {
    const ok = { name: ' Ada ', email: ' ada@example.com ' };
    expect(validateGitIdentity(ok)).toEqual({ name: 'Ada', email: 'ada@example.com' });
    for (const input of [
      { ...ok, name: '   ' },
      { ...ok, name: 'a\nb' },
      { ...ok, name: 'a'.repeat(201) },
      { ...ok, email: 'example.com' },
      { ...ok, email: 'a@\rb' },
    ]) {
      expect(() => validateGitIdentity(input)).toThrow();
    }
  });

  it('设置身份用参数数组调用 git config --global', async () => {
    const { git, exec, env } = setup();
    exec.mockImplementation(async () => 'git version 2.45.0\n');
    await git.setIdentity({ name: 'Ada', email: 'ada@example.com' });
    expect(exec).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'Ada'], { env });
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['config', '--global', 'user.email', 'ada@example.com'],
      { env }
    );
  });

  it('macOS 调用 /usr/bin/xcode-select --install；Linux 无安装动作', async () => {
    const mac = setup({ platform: 'darwin', arch: 'arm64' });
    expect(await mac.git.install()).toEqual({ started: true });
    expect(mac.exec).toHaveBeenCalledWith('/usr/bin/xcode-select', ['--install']);
    expect(mac.fetch).not.toHaveBeenCalled();
    await expect(setup({ platform: 'linux' }).git.install()).rejects.toThrow();
  });

  it('系统 git 可用时来源为 system，并读出全局身份', async () => {
    const { git, exec } = setup();
    exec.mockImplementation(async (_file, args) => {
      if (args[0] === '--version') return 'git version 2.45.0\n';
      return args[2] === 'user.name' ? 'Ada\n' : 'ada@example.com\n';
    });
    expect(await git.status()).toEqual({
      available: true,
      version: '2.45.0',
      source: 'system',
      userName: 'Ada',
      userEmail: 'ada@example.com',
    });
  });
});
