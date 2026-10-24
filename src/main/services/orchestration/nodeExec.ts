import { execFile } from 'node:child_process';
import type { ExecFn } from '@fynvra/core';

/** 单条 git 命令的上限：worktree add 会跑 post-checkout hook，不能无限期挂住编排。 */
export const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `@fynvra/core` 的 `ExecFn` 的 Node 实现（`execFile`，不经 shell）：非零退出码照常 resolve，
 * 进程起不来（git 不存在、cwd 不存在）或超时被杀时 reject（GitWorktreeManager 会转成失败结果）。
 * 关掉 git 的交互式凭据提示：编排只做本地操作，不能卡在等输入上。
 */
export const nodeExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      }
    );
  });
