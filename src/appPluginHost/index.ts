import { type HostPort, startPluginHost } from './host';

/**
 * Fynvra 插件宿主进程入口，跑在 Electron utilityProcess 里（Main 经 `?modulePath` 单独构建后 fork，每个插件一个进程）。
 * 与 Main 的通道是 Electron 注入的 `process.parentPort`；本目录不 import electron。
 */
const port = (process as unknown as { parentPort?: HostPort }).parentPort;
if (!port) throw new Error('src/appPluginHost must run in an Electron utilityProcess');

startPluginHost({ port });
