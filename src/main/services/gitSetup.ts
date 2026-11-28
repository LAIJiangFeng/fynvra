import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '@shared/guards';
import type { GitIdentityInput, GitStatus } from '@shared/types/git';
import { translate } from '../i18n';

/** 固定版本：地址与 SHA-256 取自官方 release v2.56.1.windows.1 的发布说明 */
const MINGIT_TAG = 'v2.56.1.windows.1';
const MINGIT_VERSION = '2.56.1';
export const MINGIT_FILES = {
  x64: {
    name: 'MinGit-2.56.1-64-bit.zip',
    sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd',
  },
  arm64: {
    name: 'MinGit-2.56.1-arm64.zip',
    sha256: '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c',
  },
} as const;
type MinGitArch = keyof typeof MINGIT_FILES;

/** 下载源按顺序尝试：国内镜像优先，失败回退 GitHub */
export function mingitSources(fileName: string): string[] {
  return [
    `https://registry.npmmirror.com/-/binary/git-for-windows/${MINGIT_TAG}/${fileName}`,
    `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/${fileName}`,
  ];
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const XCODE_SELECT = '/usr/bin/xcode-select';
const IDENTITY_MAX = 200;

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface GitSetupDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** 被注入 PATH 的环境（生产为 process.env） */
  env: NodeJS.ProcessEnv;
  userDataPath: string;
  /** 生产传 Electron net.fetch，走应用与系统代理 */
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  /** 不经 shell 执行，返回 stdout；非零退出、超时、找不到程序都 reject */
  exec(file: string, args: readonly string[], options?: ExecOptions): Promise<string>;
}

export function defaultExec(
  file: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

/** 去首尾空白后非空、不超长、不含换行或控制字符；邮箱还需包含 @。失败抛出可展示的错误 */
export function validateGitIdentity(input: GitIdentityInput): GitIdentityInput {
  const name = input.name.trim();
  const email = input.email.trim();
  const bad = (value: string) =>
    !value ||
    value.length > IDENTITY_MAX ||
    [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (bad(name)) throw new Error(translate('git.invalidName'));
  if (bad(email) || !email.includes('@')) throw new Error(translate('git.invalidEmail'));
  return { name, email };
}

function parseVersion(stdout: string): string {
  return stdout.trim().replace(/^git version\s+/, '');
}

export function createGitSetup(deps: GitSetupDeps) {
  const root = win32.join(deps.userDataPath, 'git');
  const arch = deps.arch in MINGIT_FILES ? (deps.arch as MinGitArch) : undefined;
  // 不支持的架构也给一个目录名，只用于判断「不存在」
  const finalDir = win32.join(root, `MinGit-${MINGIT_VERSION}-${deps.arch}`);
  const cmdDir = win32.join(finalDir, 'cmd');
  const bundledGit = win32.join(cmdDir, 'git.exe');
  let installing: Promise<GitStatus> | undefined;

  const pathEntries = (path: string | undefined) => (path ?? '').split(';').filter(Boolean);

  /** 追加到 PATH 末尾：系统装了 git 时仍优先用系统的 */
  function appendPath(): void {
    const entries = pathEntries(deps.env.PATH);
    if (entries.some((entry) => entry.toLowerCase() === cmdDir.toLowerCase())) return;
    deps.env.PATH = [...entries, cmdDir].join(';');
  }

  async function version(env?: NodeJS.ProcessEnv): Promise<string | undefined> {
    try {
      return parseVersion(await deps.exec('git', ['--version'], { env }));
    } catch {
      return undefined;
    }
  }

  async function config(key: string): Promise<string> {
    try {
      return (await deps.exec('git', ['config', '--global', key], { env: deps.env })).trim();
    } catch {
      return '';
    }
  }

  async function status(): Promise<GitStatus> {
    const found = await version(deps.env);
    if (!found) return { available: false, source: 'none', userName: '', userEmail: '' };
    let source: GitStatus['source'] = 'system';
    const entries = pathEntries(deps.env.PATH);
    const withoutBundled = entries.filter((entry) => entry.toLowerCase() !== cmdDir.toLowerCase());
    // 去掉自带目录后找不到 git，说明实际用的就是 Fynvra 那份
    if (deps.platform === 'win32' && withoutBundled.length !== entries.length) {
      const system = await version({ ...deps.env, PATH: withoutBundled.join(';') });
      if (!system) source = 'bundled';
    }
    const [userName, userEmail] = [await config('user.name'), await config('user.email')];
    return { available: true, version: found, source, userName, userEmail };
  }

  async function download(url: string, target: string, sha256: string): Promise<void> {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash('sha256');
    try {
      await pipeline(
        response.body as unknown as AsyncIterable<Uint8Array>,
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(target)
      );
      if (hash.digest('hex') !== sha256) throw new Error(translate('git.checksumMismatch'));
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  async function installWindows(file: (typeof MINGIT_FILES)[MinGitArch]): Promise<GitStatus> {
    await mkdir(root, { recursive: true });
    if (!existsSync(bundledGit)) {
      const id = randomUUID();
      const zip = win32.join(root, `.download-${id}.zip`);
      const extractDir = win32.join(root, `.extract-${id}`);
      try {
        let lastError: unknown;
        let downloaded = false;
        for (const url of mingitSources(file.name)) {
          try {
            await download(url, zip, file.sha256);
            downloaded = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!downloaded) {
          throw new Error(translate('git.downloadFailed', { error: errorMessage(lastError) }));
        }
        // 校验通过后才解压；tar 用绝对路径防 PATH 劫持
        await mkdir(extractDir, { recursive: true });
        const tar = win32.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        await deps.exec(tar, ['-xf', zip, '-C', extractDir], { timeout: EXTRACT_TIMEOUT_MS });
        try {
          await deps.exec(win32.join(extractDir, 'cmd', 'git.exe'), ['--version']);
        } catch (error) {
          throw new Error(translate('git.verifyFailed', { error: errorMessage(error) }));
        }
        await rm(finalDir, { recursive: true, force: true });
        await rename(extractDir, finalDir);
      } finally {
        await rm(zip, { force: true });
        await rm(extractDir, { recursive: true, force: true });
      }
    }
    appendPath();
    return status();
  }

  return {
    /** 启动时同步调用：自带 git 已安装就追加进 PATH，须在任何 git 调用与 worker fork 之前 */
    injectBundledPath(): void {
      if (deps.platform === 'win32' && existsSync(bundledGit)) appendPath();
    },
    status,
    /** Windows 返回安装后的状态；macOS 只调起系统安装窗口 */
    async install(): Promise<{ status?: GitStatus; started?: boolean }> {
      if (deps.platform === 'darwin') {
        await deps.exec(XCODE_SELECT, ['--install']);
        return { started: true };
      }
      if (deps.platform !== 'win32') throw new Error(translate('git.unsupportedPlatform'));
      if (!arch) throw new Error(translate('git.unsupportedArch', { arch: deps.arch }));
      // 同一时间只有一次安装，重复调用复用进行中的那次
      installing ??= installWindows(MINGIT_FILES[arch]).finally(() => {
        installing = undefined;
      });
      return { status: await installing };
    },
    async setIdentity(input: GitIdentityInput): Promise<GitStatus> {
      const { name, email } = validateGitIdentity(input);
      if (!(await version(deps.env))) throw new Error(translate('git.unavailable'));
      await deps.exec('git', ['config', '--global', 'user.name', name], { env: deps.env });
      await deps.exec('git', ['config', '--global', 'user.email', email], { env: deps.env });
      return status();
    },
  };
}

export type GitSetup = ReturnType<typeof createGitSetup>;
