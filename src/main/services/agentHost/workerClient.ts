import { errorMessage } from '@shared/guards';
import {
  type AgentCommand,
  type AgentWorkerEvent,
  type LogLevel,
  parseAgentWorkerEvent,
} from '@shared/types/agent';

/** utilityProcess 的最小面：生产由 electronWorker.ts 适配，测试注入假进程 */
export interface WorkerProcess {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export type WorkerClientState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'stopping';

export interface WorkerClientOptions {
  fork(): WorkerProcess;
  /** 已收窄的 worker 事件（ready 由本模块消化） */
  onEvent(event: Exclude<AgentWorkerEvent, { type: 'ready' }>): void;
  /** 每次 fork 之后、任何命令发出之前调用：调用方在这里为崩溃前的会话重新 spawn（新 generation） */
  onStarted?(info: { restart: boolean }): void;
  /** worker 意外退出（崩溃 / ready 超时）；willRestart 为 false 表示崩溃太频繁、不再自动重启 */
  onCrash?(info: { code: number; willRestart: boolean }): void;
  log?(level: LogLevel, message: string): void;
  /** fork 后等 ready 的上限（pi 冷启动加载较慢） */
  readyTimeoutMs?: number;
  /** 窗口内最多自动重启几次 */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** 第 n 次（窗口内）重启前等 (n - 1) × 该值：首次崩溃立即重启 */
  restartDelayMs?: number;
}

export interface WorkerClient {
  readonly state: WorkerClientState;
  /** 已停止（含放弃重启后）时 fork；会清空崩溃计数 */
  start(): void;
  /** starting 时排队、ready 后按序发出；进程不在（stopped / restarting / stopping）时返回 false */
  send(command: AgentCommand): boolean;
  /** 发 shutdown 让 worker 关闭全部会话后退出；超时则 kill */
  shutdown(timeoutMs: number): Promise<void>;
}

/**
 * Main 侧的 agent worker 进程管理：
 * fork 后等 worker 发 ready 再发命令；意外退出时在窗口内有限次自动重启，
 * 发给已退出进程的排队命令随之丢弃，由调用方在 onStarted 里重新 spawn 会话。
 */
export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const {
    readyTimeoutMs = 60_000,
    maxRestarts = 3,
    restartWindowMs = 60_000,
    restartDelayMs = 1_000,
  } = options;
  const log = options.log ?? (() => {});
  let state: WorkerClientState = 'stopped';
  let child: WorkerProcess | null = null;
  let queue: AgentCommand[] = [];
  let crashes: number[] = [];
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;

  const post = (target: WorkerProcess, command: AgentCommand): boolean => {
    try {
      target.postMessage(command);
      return true;
    } catch (error) {
      log('error', `could not send ${command.type} to the agent worker: ${errorMessage(error)}`);
      return false;
    }
  };

  const fork = (restart: boolean) => {
    let next: WorkerProcess;
    try {
      next = options.fork();
    } catch (error) {
      state = 'stopped';
      log('error', `could not start the agent worker: ${errorMessage(error)}`);
      return;
    }
    child = next;
    state = 'starting';
    queue = [];
    next.onMessage((message) => {
      if (child === next) onMessage(next, message);
    });
    next.onExit((code) => {
      if (child === next) onExit(code);
    });
    readyTimer = setTimeout(() => {
      log('error', `the agent worker did not become ready within ${readyTimeoutMs / 1000} s`);
      next.kill();
    }, readyTimeoutMs);
    options.onStarted?.({ restart });
  };

  const onMessage = (target: WorkerProcess, message: unknown) => {
    const event = parseAgentWorkerEvent(message);
    if (!event) {
      const type = (message as { type?: unknown } | null)?.type;
      log(
        'warn',
        `dropped an unparsable agent worker event: ${typeof type === 'string' ? type : '<unknown>'}`
      );
      return;
    }
    if (event.type !== 'ready') {
      options.onEvent(event);
      return;
    }
    if (state !== 'starting') return;
    clearTimeout(readyTimer);
    state = 'ready';
    const pending = queue;
    queue = [];
    for (const command of pending) post(target, command);
  };

  const onExit = (code: number) => {
    clearTimeout(readyTimer);
    child = null;
    queue = [];
    if (state === 'stopping') {
      state = 'stopped';
      stopped?.();
      return;
    }
    const now = Date.now();
    crashes = [...crashes.filter((at) => now - at < restartWindowMs), now];
    const willRestart = crashes.length <= maxRestarts;
    state = willRestart ? 'restarting' : 'stopped';
    log(
      'error',
      willRestart
        ? `the agent worker exited unexpectedly (code ${code}); restarting`
        : `the agent worker crashed ${crashes.length} times within ${restartWindowMs / 1000} s; not restarting`
    );
    options.onCrash?.({ code, willRestart });
    if (!willRestart) return;
    restartTimer = setTimeout(
      () => {
        restartTimer = undefined;
        if (state === 'restarting') fork(true);
      },
      restartDelayMs * (crashes.length - 1)
    );
  };

  let shuttingDown: Promise<void> | undefined;

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== 'stopped' && state !== 'restarting') return;
      clearTimeout(restartTimer);
      restartTimer = undefined;
      crashes = [];
      fork(false);
    },
    send(command) {
      if (state === 'ready' && child) return post(child, command);
      if (state === 'starting') {
        queue.push(command);
        return true;
      }
      return false;
    },
    shutdown(timeoutMs) {
      if (shuttingDown && state === 'stopping') return shuttingDown;
      clearTimeout(restartTimer);
      restartTimer = undefined;
      const target = child;
      if (!target) {
        state = 'stopped';
        return Promise.resolve();
      }
      const wasReady = state === 'ready';
      state = 'stopping';
      queue = [];
      shuttingDown = new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          log('warn', 'the agent worker did not exit in time; killing it');
          target.kill();
          child = null;
          state = 'stopped';
          resolve();
        }, timeoutMs);
        stopped = () => {
          clearTimeout(killTimer);
          resolve();
        };
        // 还没 ready 的 worker 不会处理命令，直接结束
        if (!wasReady || !post(target, { type: 'shutdown' })) target.kill();
      });
      return shuttingDown;
    },
  };
}
