import { utilityProcess } from 'electron';
// electron-vite 把 src/appPluginHost/index.ts 单独构建成 out/main 下的一个 chunk，这里拿到的是它的绝对路径
import appPluginHostPath from '../../../appPluginHost/index?modulePath';
import type { ForkAppPlugin } from './runtime';

/** fork 一个 Fynvra 插件宿主进程；env 由运行时按白名单给出，stdout / stderr 交给运行时进日志 */
export const forkAppPluginHost: ForkAppPlugin = ({ pluginId, cwd, env }) => {
  const child = utilityProcess.fork(appPluginHostPath, [], {
    serviceName: `fynvra-plugin-${pluginId}`,
    cwd,
    env,
    stdio: 'pipe',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener);
    },
    onExit: (listener) => {
      child.on('exit', listener);
    },
    onOutput: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener('stdout', chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => listener('stderr', chunk.toString('utf8')));
    },
    kill: () => {
      child.kill();
    },
  };
};
