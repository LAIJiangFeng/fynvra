/**
 * e2e 的 BrowserProvider：每个 attempt 启动一个真实的 Fynvra Electron，打开调试端口，
 * 把 CDP 地址交给 @e2e-dev/web 接管主窗口。按上游文档 docs/browser.mdx「Write a provider」实现。
 *
 * 每个 attempt 用独立的临时 userData（预置 settings.json）和工作区目录：不碰用户真实数据，
 * 单实例锁按 userData 区分，也不会和正在运行的安装版 Fynvra 冲突。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserLease, BrowserProvider } from '@e2e-dev/web';
import type { Seed } from './seed';

export interface FynvraElectronOptions {
  /** 仓库根目录。Electron 在这里以 `electron .` 启动，app.getAppPath() 才等于项目根。 */
  readonly projectRoot: string;
  /** app.command 托管 out/renderer 的地址，经 ELECTRON_RENDERER_URL 交给主窗口加载。 */
  readonly rendererUrl: string;
  /** 每个 attempt 预置的设置和工作区内容。 */
  readonly seed: Seed;
  /** 等待调试端口和主窗口就绪的上限，默认 60 s。 */
  readonly readyTimeoutMs?: number;
}

/** id 是 Electron 主进程的 pid；tempDir 只给 release 用，引擎只读 id 和 cdpEndpoint。 */
interface FynvraLease extends BrowserLease {
  readonly tempDir: string;
}

const TEMP_PREFIX = 'fynvra-e2e-';
/** mkdtemp 在前缀后补 6 个随机字符。 */
const TEMP_DIR_NAME = /^fynvra-e2e-[A-Za-z0-9]{6}$/;
/** Chromium 打开调试端口后写到 stderr 的一行；要求带换行，避免匹配到被分块截断的地址。 */
const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)\r?\n/;
const OUTPUT_TAIL_CHARS = 8_000;

/** 只有这些变量传给 Electron：不透传模型 key、GITHUB_TOKEN 等任何其他变量，也不带 ELECTRON_RUN_AS_NODE。 */
const INHERITED_ENV =
  process.platform === 'win32'
    ? [
        'PATH',
        'PATHEXT',
        'SystemRoot',
        'SystemDrive',
        'windir',
        'ComSpec',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'APPDATA',
        'LOCALAPPDATA',
        'ProgramData',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramW6432',
        'CommonProgramFiles',
        'CommonProgramFiles(x86)',
        'CommonProgramW6432',
        'ALLUSERSPROFILE',
        'PUBLIC',
        'USERNAME',
        'COMPUTERNAME',
        'OS',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ]
    : [
        'PATH',
        'HOME',
        'USER',
        'TMPDIR',
        'LANG',
        'DISPLAY',
        'XAUTHORITY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR',
      ];

/** 本 worker 启动的 Electron，按 lease id 记录；release 只结束这里记录的进程。 */
const launched = new Map<string, ChildProcess>();

export function fynvraElectron(options: FynvraElectronOptions): BrowserProvider {
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  return {
    name: 'fynvra-electron',
    scope: 'attempt',
    async acquire(request) {
      request.signal.throwIfAborted();
      const mainEntry = join(options.projectRoot, 'out', 'main', 'index.js');
      if (!existsSync(mainEntry)) {
        throw new Error(`${mainEntry} 不存在：先运行 pnpm build（pnpm test:e2e 会先构建）`);
      }
      const electron = electronExecutable(options.projectRoot);
      const tempDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
      const output = new ElectronOutput();
      let child: ChildProcess | undefined;
      try {
        const userData = await seedTempDir(tempDir, options.seed);
        request.signal.throwIfAborted();
        child = spawn(electron, ['.', '--remote-debugging-port=0'], {
          cwd: options.projectRoot,
          env: {
            ...inheritedEnv(request.env),
            FYNVRA_USER_DATA_DIR: userData,
            ELECTRON_RENDERER_URL: options.rendererUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          // POSIX 下自成进程组，release 能连同 Electron 的子进程一起结束。
          detached: process.platform !== 'win32',
        });
        output.attach(child);
        const cdpEndpoint = await waitUntilReady(
          child,
          output,
          options,
          readyTimeoutMs,
          request.signal
        );
        const lease: FynvraLease = { id: String(child.pid), cdpEndpoint, tempDir };
        launched.set(lease.id, child);
        request.log(`Fynvra pid ${lease.id}，临时数据 ${tempDir}`);
        return lease;
      } catch (cause) {
        if (child !== undefined) await stopElectron(child, tempDir, request.log);
        await removeTempDir(tempDir, request.log);
        throw new Error(`Fynvra 启动失败：${errorText(cause)}\n${output.describe()}`, { cause });
      }
    },
    async release(lease, context) {
      const child = launched.get(lease.id);
      launched.delete(lease.id);
      const { tempDir } = lease as Partial<FynvraLease>;
      if (child !== undefined) await stopElectron(child, tempDir, context.log);
      else context.log(`没有 lease ${lease.id} 对应的 Electron 进程记录，跳过结束进程`);
      if (typeof tempDir === 'string') await removeTempDir(tempDir, context.log);
    },
  };
}

/** 项目依赖里 electron 包给出的可执行文件路径（从 Node 里 require 得到的是路径字符串）。 */
function electronExecutable(projectRoot: string): string {
  const requireFromRoot = createRequire(join(projectRoot, 'package.json'));
  const executable: unknown = requireFromRoot('electron');
  if (typeof executable !== 'string') throw new Error('electron 包没有给出可执行文件路径');
  return executable;
}

/** 写入临时 userData 的 settings.json 和测试工作区，返回 userData 路径。 */
async function seedTempDir(tempDir: string, seed: Seed): Promise<string> {
  const userData = join(tempDir, 'user-data');
  const workspace = join(tempDir, 'workspace');
  await mkdir(userData);
  await mkdir(workspace);
  await writeFile(join(workspace, seed.file.name), seed.file.content, 'utf8');
  const settings = {
    version: 1,
    preferences: { language: seed.language, theme: 'light', sidePanelOpen: true },
    workspaces: [
      { id: seed.workspace.id, name: seed.workspace.name, repoPath: workspace, vcs: 'none' },
    ],
  };
  await writeFile(join(userData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return userData;
}

/** 按白名单从 run 的环境（request.env，不读 process.env）挑变量；Windows 变量名不区分大小写。 */
function inheritedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const windows = process.platform === 'win32';
  const keys = Object.keys(env);
  const picked: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const key = windows
      ? keys.find((candidate) => candidate.toUpperCase() === name.toUpperCase())
      : name;
    const value = key === undefined ? undefined : env[key];
    if (value !== undefined && value !== '') picked[name] = value;
  }
  return picked;
}

/** 收集 Electron 的输出：保留末尾若干字符用于报错，并从 stderr 解析调试端口地址。 */
class ElectronOutput {
  private tail = '';
  private stderr = '';
  private resolveEndpoint: ((endpoint: string) => void) | undefined;
  /** stderr 打出调试端口后得到浏览器级 ws:// 地址。 */
  readonly endpoint: Promise<string>;

  constructor() {
    this.endpoint = new Promise((resolve) => {
      this.resolveEndpoint = resolve;
    });
  }

  attach(child: ChildProcess): void {
    child.on('error', (error) => this.append(`[spawn] ${error.message}\n`));
    // 两路管道都持续读取，避免缓冲区写满后 Electron 阻塞。
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => this.append(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.append(chunk);
      if (this.resolveEndpoint === undefined) return;
      this.stderr = (this.stderr + chunk).slice(-OUTPUT_TAIL_CHARS);
      const endpoint = DEVTOOLS_LINE.exec(this.stderr)?.[1];
      if (endpoint === undefined) return;
      this.resolveEndpoint(endpoint);
      this.resolveEndpoint = undefined;
    });
  }

  describe(): string {
    const text = this.tail.trimEnd();
    return text === '' ? '（Electron 没有输出）' : `Electron 输出末尾：\n${text}`;
  }

  private append(chunk: string): void {
    this.tail = (this.tail + chunk).slice(-OUTPUT_TAIL_CHARS);
  }
}

/**
 * 等到 stderr 给出调试端口，且 /json/list 里出现加载 rendererUrl 的 page，返回浏览器级 CDP 地址。
 * 超时、子进程提前退出或 request.signal 中止时抛出原因。
 */
async function waitUntilReady(
  child: ChildProcess,
  output: ElectronOutput,
  options: FynvraElectronOptions,
  timeoutMs: number,
  signal: AbortSignal
): Promise<string> {
  const failure = new AbortController();
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
    failure.abort(new Error(`Electron 在就绪前退出（code ${code}，signal ${exitSignal}）`));
  const onError = (error: Error) => failure.abort(error);
  const onAbort = () => failure.abort(signal.reason ?? new Error('acquire 被中止'));
  const timer = setTimeout(
    () => failure.abort(new Error(`${timeoutMs / 1000} s 内没有就绪`)),
    timeoutMs
  );
  child.once('exit', onExit);
  child.once('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const endpoint = await abortable(output.endpoint, failure.signal);
    await waitForRendererPage(endpoint, options.rendererUrl, failure.signal);
    return endpoint;
  } catch (cause) {
    throw failure.signal.aborted ? failure.signal.reason : cause;
  } finally {
    clearTimeout(timer);
    child.off('exit', onExit);
    child.off('error', onError);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 轮询调试端口的 /json/list，直到主窗口是一个 url 以 rendererUrl 开头的 page。 */
async function waitForRendererPage(
  endpoint: string,
  rendererUrl: string,
  signal: AbortSignal
): Promise<void> {
  const list = `http://${new URL(endpoint).host}/json/list`;
  const expected = new URL(rendererUrl).href;
  for (;;) {
    try {
      const response = await fetch(list, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      const targets: unknown = response.ok ? await response.json() : [];
      if (Array.isArray(targets) && targets.some((target) => isRendererPage(target, expected))) {
        return;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // 调试端口可能还没开始应答，下一轮再试。
    }
    await delay(250, undefined, { signal });
  }
}

function isRendererPage(target: unknown, expected: string): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const { type, url } = target as { type?: unknown; url?: unknown };
  return type === 'page' && typeof url === 'string' && url.startsWith(expected);
}

/** 结束本 worker 启动的整棵 Electron 进程树并等它退出。 */
async function stopElectron(
  child: ChildProcess,
  tempDir: string | undefined,
  log: (line: string) => void
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Node 处理完退出事件前一直持有子进程句柄，这期间 PID 不会被复用；已退出就不再按 PID 结束。
    for (let round = 1; round <= 3 && !hasExited(child); round += 1) {
      const { code } = await run(systemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F']);
      // 启动途中结束时，子进程在枚举后退出会让 taskkill 报错并留下主进程，再来一次。
      if (await waitForExit(child, code === 0 ? 5_000 : 1_000)) break;
      if (round === 3) log(`taskkill /PID ${pid} /T /F 退出码 ${code}，主进程仍在运行`);
    }
  } else {
    // 进程组还有成员时它的 id 不会被复用，所以组长退出后仍可安全地向整组发信号。
    signalGroup(pid, 'SIGTERM');
    if (!(await waitForExit(child, 5_000))) signalGroup(pid, 'SIGKILL');
  }
  if (!(await waitForExit(child, 5_000))) log(`Electron pid ${pid} 5 s 内没有退出`);
  if (process.platform === 'win32' && tempDir !== undefined) await killStragglers(tempDir, log);
}

/**
 * taskkill /T 只结束它枚举那一刻的进程树：启动途中被结束时，正在创建的辅助进程
 * （实测是 agent host 的 utilityProcess）会成为孤儿。主进程退出后不会再有新的辅助进程，
 * 而它们的命令行都带本 attempt 独有的临时目录（--user-data-dir），按它再找一遍并结束。
 */
async function killStragglers(tempDir: string, log: (line: string) => void): Promise<void> {
  if (!isOwnTempDir(tempDir)) return;
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$needle = ${quote(tempDir)}`,
    'Get-CimInstance Win32_Process' +
      ' | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }' +
      ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }',
  ].join('; ');
  const { stdout } = await run(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
  const pids = stdout.split(/\s+/).filter((text) => /^\d+$/.test(text));
  if (pids.length > 0) log(`结束了命令行引用 ${tempDir} 的残留进程：${pids.join(', ')}`);
}

function systemTool(...segments: string[]): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...segments);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 整组都已退出。
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function run(
  command: string,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.once('error', () => resolvePromise({ code: null, stdout }));
    proc.once('close', (code) => resolvePromise({ code, stdout }));
  });
}

/** mkdtemp 在系统临时目录下建的 fynvra-e2e-XXXXXX；只按这样的目录删文件、找进程。 */
function isOwnTempDir(dir: string): boolean {
  return TEMP_DIR_NAME.test(basename(dir)) && resolve(dirname(dir)) === resolve(tmpdir());
}

/** 尽力删除本 provider 建的临时目录；文件被占用时重试几次，仍失败只记日志。 */
async function removeTempDir(dir: string, log: (line: string) => void): Promise<void> {
  if (!isOwnTempDir(dir)) {
    log(`${dir} 不是本 provider 建的临时目录，不删除`);
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 5) {
        log(`临时目录 ${dir} 删除失败：${errorText(error)}`);
        return;
      }
      await delay(attempt * 500);
    }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
