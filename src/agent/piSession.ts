import { dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  createRoleSession,
  type McpServerConfig,
  type ResolvedModel,
  subscribeNormalized,
} from '@fynvra/agent-runtime';
import type { AgentMcpServer, ResolvedModelSpec } from '@shared/types/agent';
import type { OpenSession } from './supervisor';

/** dispose 前先中止进行中的回合（pi 的 bash 是独立进程组，只在中止时整树结束），最多等这么久 */
const ABORT_BEFORE_DISPOSE_MS = 5_000;

export interface PiSessionFactoryOptions {
  /** fynvra 的 pi agentDir（userData/agent），与 PI_CODING_AGENT_DIR 相同 */
  agentDir: string;
  resolveModel(spec: ResolvedModelSpec): Promise<ResolvedModel>;
  /** 事件 listener 抛出的异常（被 subscribeNormalized 兜住，不打断 pi 的 jsonl 持久化） */
  onListenerError?: (error: unknown) => void;
}

/**
 * 生产用的会话工厂：在 Main 指定的 jsonl 上打开 pi 会话（文件不存在时新建，存在时续写），
 * 按角色经 createRoleSession 组装工具 / 提示词 / skills / MCP，事件统一走 subscribeNormalized。
 */
export function createPiSessionFactory(options: PiSessionFactoryOptions): OpenSession {
  return async ({ spec, host, workerHost }) => {
    const model = await options.resolveModel(spec.model);
    const sessionManager = SessionManager.open(
      spec.sessionFile,
      dirname(spec.sessionFile),
      spec.cwd
    );
    const created = await createRoleSession({
      role: spec.role,
      cwd: spec.cwd,
      model,
      sessionManager,
      host,
      workerHost,
      resourcePaths: { skills: spec.skills, mcpServers: spec.mcpServers.map(toMcpServerConfig) },
      agentDir: options.agentDir,
      roles: spec.roles,
    });
    const { session } = created;
    return {
      warnings: created.warnings,
      subscribe: (listener) => {
        const subscription = subscribeNormalized(
          session,
          listener,
          options.onListenerError ? { onListenerError: options.onListenerError } : {}
        );
        return { unsubscribe: subscription.unsubscribe, emit: subscription.emit };
      },
      prompt: (text) => session.prompt(text, { streamingBehavior: 'followUp' }),
      steer: async (text) => {
        await session.steer(text);
      },
      abort: () => session.abort(),
      isIdle: () => session.isIdle,
      dispose: async () => {
        if (!session.isIdle) await withTimeout(session.abort(), ABORT_BEFORE_DISPOSE_MS);
        await created.dispose();
      },
    };
  };
}

/**
 * Main 解析好的服务器 → pi 的 McpServerConfig。设置里的 http / sse 都映射为 pi 的 `http`（pi 没有单独的 sse 类型）。
 * 协议消息不带传输方式，按有无 url 区分；这里显式写上 `type`，不依赖 pi 的推断。
 */
export function toMcpServerConfig(server: AgentMcpServer): McpServerConfig {
  if (server.url) {
    return {
      name: server.name,
      type: 'http',
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  return {
    name: server.name,
    type: 'stdio',
    command: server.command ?? '',
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

async function withTimeout(task: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
