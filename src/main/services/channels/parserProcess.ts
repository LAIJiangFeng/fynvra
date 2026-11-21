// 附件解析子进程的 Electron 实现：utilityProcess.fork 与按 pid 查内存。docIsolation 懒加载本文件，单元测试注入假进程。
import { tmpdir } from 'node:os';
import { app, utilityProcess } from 'electron';
// electron-vite 把 attachmentParser.ts 单独构建成 out/main 下的一个 chunk，这里拿到的是它的绝对路径
import parserPath from './attachmentParser?modulePath';
import type { ForkParser } from './docIsolation';

export const forkAttachmentParser: ForkParser = ({ env }) => {
  const child = utilityProcess.fork(parserPath, [], {
    serviceName: 'fynvra-attachment-parser',
    cwd: tmpdir(),
    env,
    execArgv: ['--max-old-space-size=512'],
    stdio: 'ignore',
  });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener);
    },
    onExit: (listener) => {
      child.on('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
};

/** 子进程当前内存（KB）：workingSetSize 与 privateBytes（仅 Windows）取大；查不到返回 undefined */
export function processMemoryKb(pid: number): number | undefined {
  const memory = app.getAppMetrics().find((metric) => metric.pid === pid)?.memory;
  return memory && Math.max(memory.workingSetSize, memory.privateBytes ?? 0);
}
