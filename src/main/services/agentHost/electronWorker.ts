import { utilityProcess } from 'electron';
// electron-vite 把 src/agent/index.ts 单独构建成 out/main 下的一个 chunk，这里拿到的是它的绝对路径
import agentWorkerPath from '../../../agent/index?modulePath';
import { ENV_MODEL_SECRET_VARS } from './envModelResolver';
import type { WorkerProcess } from './workerClient';

/**
 * fork agent worker（Electron utilityProcess）。
 * PI_CODING_AGENT_DIR 指向 fynvra 的 agentDir：pi 在模块加载时读它，不设会落到用户的 ~/.pi/agent。
 * 环境变量里的模型 key 不带给 worker：key 只经 spawn-session 交出去。
 */
export function forkAgentWorker(agentDir: string): WorkerProcess {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !ENV_MODEL_SECRET_VARS.includes(name)) env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  const child = utilityProcess.fork(agentWorkerPath, [], {
    serviceName: 'fynvra-agent-worker',
    env,
  });
  return {
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
}
