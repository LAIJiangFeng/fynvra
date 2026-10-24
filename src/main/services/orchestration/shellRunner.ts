import { type ChildProcess, spawn } from 'node:child_process';
import { errorMessage } from '@shared/guards';
import type { RunChecksFn } from './host';

/** 检查命令的默认时限。 */
export const RUN_CHECKS_TIMEOUT_MS = 20 * 60_000;
/** 合并输出最多保留的尾部字符数（工具只把最后约 12k 字符给模型）。 */
export const RUN_CHECKS_OUTPUT_LIMIT = 1_000_000;

export interface ShellRunnerOptions {
  timeoutMs?: number;
  outputLimit?: number;
}

/** 结束整个进程树：shell 起的子进程（pnpm → node → vitest…）不能留下来占着 worktree。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    // detached 启动时子进程是进程组组长，负 pid 杀整组
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * run_checks 的默认执行器：在 `cwd` 里经 shell 执行命令（命令已过白名单），stdout 与 stderr
 * 按到达顺序合并。超时或 `signal` 中止时结束整个进程树，`exitCode` 为 -1 并在输出末尾注明原因。
 * 从不 reject；关闭颜色输出，便于模型阅读。
 */
export function createShellRunner(options: ShellRunnerOptions = {}): RunChecksFn {
  const timeoutMs = options.timeoutMs ?? RUN_CHECKS_TIMEOUT_MS;
  const limit = options.outputLimit ?? RUN_CHECKS_OUTPUT_LIMIT;

  return (cwd, command, signal) =>
    new Promise((resolve) => {
      const startedAt = performance.now();
      let output = '';
      let stopped: string | undefined;
      let settled = false;
      const append = (chunk: string) => {
        output += chunk;
        if (output.length > limit) output = output.slice(-limit);
      };

      if (signal?.aborted) {
        resolve({
          exitCode: -1,
          output: '[fynvra] aborted before the command started',
          durationMs: 0,
        });
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
      } catch (error) {
        resolve({ exitCode: -1, output: errorMessage(error), durationMs: 0 });
        return;
      }

      const stop = (reason: string) => {
        if (stopped !== undefined) return;
        stopped = reason;
        killTree(child);
      };
      const onAbort = () => stop('aborted');
      const timer = setTimeout(
        () => stop(`timed out after ${Math.round(timeoutMs / 1000)} s and was stopped`),
        timeoutMs
      );
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (stopped !== undefined) append(`\n[fynvra] command ${stopped}\n`);
        resolve({
          exitCode: stopped === undefined ? exitCode : -1,
          output,
          durationMs: Math.round(performance.now() - startedAt),
        });
      };

      child.stdout?.setEncoding('utf8').on('data', append);
      child.stderr?.setEncoding('utf8').on('data', append);
      child.on('error', (error) => {
        append(`${error.message}\n`);
        finish(-1);
      });
      child.on('close', (code) => finish(code ?? -1));
    });
}
