import { errorMessage } from '@shared/guards';
import { type AgentWorkerEvent, parseAgentCommand } from '@shared/types/agent';
import { createModelRegistry, createWorkerModelRuntime, type ModelRegistry } from './models';
import { createPiSessionFactory } from './piSession';
import { SessionSupervisor } from './supervisor';

/**
 * Agent worker 入口，跑在 Electron utilityProcess 里（Main 经 `?modulePath` 单独构建后 fork）。
 *
 * 与 Main 的通道是 Electron 注入的 `process.parentPort`，与 EnsoCode 相同；node:worker_threads 的
 * parentPort 只属于 worker 线程，在 utilityProcess 里是 null。本目录不 import electron，这里只声明用到的两个方法。
 */
interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('src/agent must run in an Electron utilityProcess');
// pi 在模块加载时读 PI_CODING_AGENT_DIR（rg / fd 的下载目录等），Main fork 时已设好；fynvra 的 agentDir 与它相同
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error('PI_CODING_AGENT_DIR is required');

const post = (event: AgentWorkerEvent) => port.postMessage(event);
const log = (level: 'info' | 'warn' | 'error', message: string) =>
  post({ type: 'log', level, message });

let models: Promise<ModelRegistry> | undefined;
const modelRegistry = (): Promise<ModelRegistry> =>
  (models ??= createWorkerModelRuntime(agentDir).then(createModelRegistry));
const supervisor = new SessionSupervisor({
  post,
  openSession: createPiSessionFactory({
    agentDir,
    resolveModel: async (spec) => (await modelRegistry()).resolve(spec),
    onListenerError: (error) =>
      log('error', `session event listener failed: ${errorMessage(error)}`),
    // 只写协议、模型、档位与请求地址（去掉 userinfo 与 query），不写 key
    onModelSelected: (sessionId, { model, thinking }) =>
      log(
        'info',
        `session ${sessionId}: ${model.api} ${model.id}${thinking ? ` thinking=${thinking}` : ''} → ${endpointOf(model.baseUrl)}`
      ),
  }),
  describeModels: async (queries) => {
    const registry = await modelRegistry();
    return queries.map((query) => registry.describe(query));
  },
});

function endpointOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid base URL)';
  }
}

let exiting = false;
function exit(): void {
  if (exiting) return;
  exiting = true;
  void supervisor.shutdown().finally(() => process.exit(0));
}

port.on('message', (event) => {
  const command = parseAgentCommand(event.data);
  if (!command) {
    // 静默丢弃会让 Main 只能干等；契约漂移要在这里就看得见
    const type = (event.data as { type?: unknown } | null)?.type;
    log('warn', `dropped an unparsable command: ${typeof type === 'string' ? type : '<unknown>'}`);
    return;
  }
  if (command.type === 'shutdown') {
    exit();
    return;
  }
  supervisor.handle(command);
});

// utilityProcess.kill() 在 POSIX 上发 SIGTERM：退出前关闭会话（MCP 连接、bash 进程组）
process.on('SIGTERM', exit);
process.on('SIGINT', exit);
// 一个会话的异步失败不应拖垮托管其他会话的进程
process.on('unhandledRejection', (reason) =>
  log('error', `unhandled rejection: ${errorMessage(reason)}`)
);

post({ type: 'ready' });
