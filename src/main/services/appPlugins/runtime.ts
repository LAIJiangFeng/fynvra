// Fynvra 插件运行时（ARCHITECTURE §7.12「Fynvra 插件」）：每个启用的插件一个进程；启动、停用、
// 崩溃退避重启（2 秒起翻倍，最长 60 秒；10 分钟内 3 次自动停用）、退出时 deactivate 后 5 秒强杀。
import { join } from 'node:path';
import type { PluginLogLevel } from '@shared/types/appPluginApi';
import {
  type AppPluginStatus,
  type AppPluginView,
  parseHostOutbound,
} from '@shared/types/appPlugins';
import { API_METHODS, type ApiDeps, type ApiMethod } from './api';
import { createPluginConnection, messageSize, type PluginConnection } from './connection';
import type { AppPluginRecord, AppPluginRegistry } from './registry';
import { readManifestDescription } from './service';

export const DEACTIVATE_TIMEOUT_MS = 5_000;
export const RESTART_BASE_MS = 2_000;
export const RESTART_MAX_MS = 60_000;
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
export const MAX_CRASHES = 3;
/** 进程只拿到这些环境变量：不带密钥，也不带代理 */
export const ENV_WHITELIST = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATH', 'LANG', 'TZ'] as const;

export interface AppPluginProcess {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  /** stdout / stderr 的文本块 */
  onOutput(listener: (stream: 'stdout' | 'stderr', text: string) => void): void;
  kill(): void;
}

export type ForkAppPlugin = (options: {
  pluginId: string;
  cwd: string;
  env: Record<string, string>;
}) => AppPluginProcess | Promise<AppPluginProcess>;

export interface AppPluginRuntimeDeps {
  registry: AppPluginRegistry;
  fork: ForkAppPlugin;
  apiDeps: ApiDeps;
  /** `userData/fynvra-plugin-data` */
  dataRoot: string;
  /** 进程启动前建好私有数据目录 */
  ensureDir: (dir: string) => Promise<void>;
  /** 宿主入口里插件模块的绝对路径 */
  entryPathOf: (record: AppPluginRecord, main: string) => string;
  /** 读包里清单的 host.main；读不到返回 null */
  readMain: (record: AppPluginRecord) => Promise<string | null>;
  onChanged: () => void;
  methods?: Readonly<Record<string, ApiMethod>>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  deactivateTimeoutMs?: number;
}

export interface AppPluginRuntime {
  /** 启动全部启用的插件 */
  startAll(): Promise<void>;
  /** 启用 / 停用并立即生效；不存在返回 undefined */
  setEnabled(id: string, enabled: boolean): Promise<AppPluginRecord | undefined>;
  /** 启动（已在运行则不动）；未启用时什么也不做 */
  start(id: string): Promise<void>;
  /** 停止进程（deactivate，超时强杀）；不改登记 */
  stop(id: string): Promise<void>;
  /** 退出时：全部 deactivate，等待后强杀 */
  shutdown(): Promise<void>;
  status(id: string): AppPluginStatus;
  view(record: AppPluginRecord): AppPluginView;
  /** 给 H2 / H3：向运行中的插件推事件、调插件的 handle */
  emit(id: string, event: string, payload: unknown): void;
  call(id: string, name: string, args: unknown): Promise<unknown>;
}

interface Running {
  process: AppPluginProcess;
  connection: PluginConnection;
  status: 'starting' | 'running';
  /** 是 Main 主动要它退出的 */
  stopping: boolean;
  exited: Promise<void>;
}

interface CrashState {
  times: number[];
  consecutive: number;
  timer?: unknown;
}

/** 从父进程环境挑出白名单变量（Windows 下环境变量名不分大小写） */
export function pickPluginEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = Object.entries(source);
  for (const name of ENV_WHITELIST) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found?.[1] !== undefined) result[name] = found[1];
  }
  return result;
}

export function createAppPluginRuntime(deps: AppPluginRuntimeDeps): AppPluginRuntime {
  const {
    registry,
    fork,
    apiDeps,
    dataRoot,
    ensureDir,
    entryPathOf,
    readMain,
    onChanged,
    methods = API_METHODS,
    env = process.env,
    now = Date.now,
    setTimer = (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    },
    clearTimer = (handle) => clearTimeout(handle as NodeJS.Timeout),
    deactivateTimeoutMs = DEACTIVATE_TIMEOUT_MS,
  } = deps;
  const running = new Map<string, Running>();
  const crashes = new Map<string, CrashState>();
  const crashedNow = new Set<string>();
  const launching = new Set<string>();
  let shuttingDown = false;

  const dataDirOf = (id: string) => join(dataRoot, id);
  const log = (id: string, level: PluginLogLevel, message: string) =>
    apiDeps.log(id, level, message);

  async function start(id: string): Promise<void> {
    if (shuttingDown || running.has(id) || launching.has(id)) return;
    launching.add(id);
    try {
      await launch(id);
    } finally {
      launching.delete(id);
    }
  }

  async function launch(id: string): Promise<void> {
    const record = await registry.get(id);
    if (!record?.enabled) return;
    const main = await readMain(record);
    if (!main) {
      await failed(id, 'plugin manifest or host.main is missing');
      return;
    }
    const dataDir = dataDirOf(id);
    await ensureDir(dataDir);
    const child = await fork({ pluginId: id, cwd: dataDir, env: pickPluginEnv(env) });
    if (shuttingDown) {
      child.kill();
      return;
    }
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const connection = createPluginConnection({
      pluginId: id,
      dataDir,
      permissions: record.permissions,
      methods,
      deps: apiDeps,
      post: (message) => child.postMessage(message),
    });
    const entry: Running = {
      process: child,
      connection,
      status: 'starting',
      stopping: false,
      exited,
    };
    running.set(id, entry);
    crashedNow.delete(id);
    let activateError: string | undefined;
    child.onMessage((raw) => {
      const message = parseHostOutbound(raw);
      if (!message) return;
      if (message.type === 'activated') {
        entry.status = 'running';
        onChanged();
      } else if (message.type === 'activate-failed') {
        activateError = message.error;
        log(id, 'error', `activate failed: ${message.error}`);
      } else {
        connection.receive(message, messageSize(raw));
      }
    });
    child.onOutput((stream, text) => log(id, stream === 'stderr' ? 'warn' : 'info', text));
    child.onExit((code) => {
      connection.close('plugin process exited');
      if (running.get(id) === entry) running.delete(id);
      markExited();
      if (entry.stopping || shuttingDown) {
        onChanged();
        return;
      }
      void onCrash(id, activateError ?? `plugin process exited unexpectedly (code ${code})`);
    });
    child.postMessage({
      type: 'init',
      pluginId: id,
      entryPath: entryPathOf(record, main),
      dataDir,
    });
    onChanged();
  }

  /** 启动前就失败（清单缺失等）：直接停用并记原因，不重试 */
  async function failed(id: string, error: string): Promise<void> {
    log(id, 'error', error);
    crashedNow.add(id);
    await registry.update(id, { enabled: false, lastError: error });
    onChanged();
  }

  async function onCrash(id: string, error: string): Promise<void> {
    const state = crashes.get(id) ?? { times: [], consecutive: 0 };
    crashes.set(id, state);
    const at = now();
    state.times = [...state.times.filter((time) => at - time < CRASH_WINDOW_MS), at];
    state.consecutive += 1;
    crashedNow.add(id);
    log(id, 'error', error);
    if (state.times.length >= MAX_CRASHES) {
      await registry.update(id, {
        enabled: false,
        lastError: `${error}; disabled after ${MAX_CRASHES} crashes within 10 minutes`,
      });
      onChanged();
      return;
    }
    await registry.update(id, { lastError: error });
    onChanged();
    const delay = Math.min(RESTART_BASE_MS * 2 ** (state.consecutive - 1), RESTART_MAX_MS);
    state.timer = setTimer(() => {
      state.timer = undefined;
      void start(id).catch((reason: unknown) =>
        log(id, 'error', `restart failed: ${String(reason)}`)
      );
    }, delay);
  }

  function cancelRestart(id: string): void {
    const state = crashes.get(id);
    if (state?.timer !== undefined) clearTimer(state.timer);
    if (state) state.timer = undefined;
  }

  async function stop(id: string): Promise<void> {
    cancelRestart(id);
    const entry = running.get(id);
    if (!entry) return;
    entry.stopping = true;
    try {
      entry.process.postMessage({ type: 'deactivate' });
    } catch {
      // 进程已不在
    }
    let timer: unknown;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimer(() => resolve('timeout'), deactivateTimeoutMs);
    });
    const result = await Promise.race([entry.exited.then(() => 'exited' as const), timedOut]);
    clearTimer(timer);
    if (result === 'timeout') {
      log(id, 'warn', 'deactivate timed out, killing the process');
      entry.process.kill();
      // 退出事件可能来得晚：登记上直接视为已停
      if (running.get(id) === entry) running.delete(id);
      entry.connection.close('plugin process killed');
    }
  }

  function status(id: string): AppPluginStatus {
    const entry = running.get(id);
    if (entry) return entry.status;
    return crashedNow.has(id) ? 'crashed' : 'stopped';
  }

  return {
    async startAll() {
      for (const record of await registry.list()) {
        // 支持简介之前写入的旧登记没有 description：从清单补上；失败只记错误码，不影响启动
        if (record.description === undefined) {
          try {
            const description = await readManifestDescription(record.path);
            if (description !== undefined) await registry.update(record.id, { description });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            log(record.id, 'warn', `description backfill skipped: ${code ?? 'unknown'}`);
          }
        }
        if (record.enabled) {
          await start(record.id).catch((error: unknown) =>
            log(record.id, 'error', `start failed: ${String(error)}`)
          );
        }
      }
    },
    async setEnabled(id, enabled) {
      if (!enabled) await stop(id);
      // 手动启用：清掉上次的错误与崩溃计数
      const updated = await registry.update(
        id,
        enabled ? { enabled, lastError: undefined } : { enabled }
      );
      if (!updated) return undefined;
      if (enabled) {
        crashes.delete(id);
        crashedNow.delete(id);
        await start(id);
      }
      onChanged();
      return updated;
    },
    start,
    stop,
    async shutdown() {
      shuttingDown = true;
      await Promise.all([...running.keys()].map((id) => stop(id)));
    },
    status,
    view(record) {
      return {
        id: record.id,
        name: record.name,
        version: record.version,
        ...(record.description !== undefined ? { description: record.description } : {}),
        tier: record.tier ?? null,
        source: record.source,
        enabled: record.enabled,
        status: status(record.id),
        ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
        permissions: [...record.permissions],
        ...(record.revokedReason !== undefined ? { revokedReason: record.revokedReason } : {}),
      };
    },
    emit(id, event, payload) {
      running.get(id)?.connection.emit(event, payload);
    },
    call(id, name, args) {
      const entry = running.get(id);
      return entry
        ? entry.connection.call(name, args)
        : Promise.reject(new Error('plugin is not running'));
    },
  };
}
