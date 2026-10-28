import { execFile } from 'node:child_process';

export interface ExecResult {
  /** 进程退出码；无法启动（如 ENOENT）或被信号终止时为非 0 */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 注入式命令执行（不经 shell）。实现不得 reject：失败以非 0 `code` 返回。 */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  options?: ExecOptions
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 基于 `child_process.execFile` 的默认实现 */
export const nodeExec: ExecFn = (cmd, args, cwd, options = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // 非 0 退出时 code 是数字；启动失败时是 'ENOENT' 之类的字符串
        const code = typeof error.code === 'number' && error.code !== 0 ? error.code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || error.message });
      }
    );
  });
