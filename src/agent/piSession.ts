import { dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  type ApprovalGate,
  createRoleSession,
  type McpServerConfig,
  type ResolvedModel,
  subscribeNormalized,
} from '@fynvra/agent-runtime';
import type { Role } from '@fynvra/core';
import type { AgentMcpServer, ResolvedModelSpec } from '@shared/types/agent';
import { createSessionSettings } from './shell';
import type { OpenSession } from './supervisor';

/** dispose 前先中止进行中的回合（pi 的 bash 是独立进程组，只在中止时整树结束），最多等这么久 */
const ABORT_BEFORE_DISPOSE_MS = 5_000;

export interface PiSessionFactoryOptions {
  /** fynvra 的 pi agentDir（userData/agent），与 PI_CODING_AGENT_DIR 相同 */
  agentDir: string;
  /** 注册 provider 并取 pi 的模型；思考档位按模型的可选集合落定（见 models.ts） */
  resolveModel(spec: ResolvedModelSpec): Promise<ResolvedModel>;
  /** 事件 listener 抛出的异常（被 subscribeNormalized 兜住，不打断 pi 的 jsonl 持久化） */
  onListenerError?: (error: unknown) => void;
  /** 会话用上了一个模型（创建时、换模型后）：入口据此记一条日志，之后的请求都打到这个地址 */
  onModelSelected?: (sessionId: string, model: ResolvedModel) => void;
}

/**
 * 生产用的会话工厂：在 Main 指定的 jsonl 上打开 pi 会话（文件不存在时新建，存在时续写），
 * 按角色经 createRoleSession 组装工具 / 提示词 / skills / MCP，事件统一走 subscribeNormalized。
 * 换模型直接调 pi 的 setModel / setThinkingLevel：pi 在 jsonl 里记一条模型切换，历史照常保留。
 * 审批门由 createRoleSession 按 spec.role.approvalMode（Main 给的会话档位）建好，经 onGate 交回这里，换档位调它的 setMode。
 */
export function createPiSessionFactory(options: PiSessionFactoryOptions): OpenSession {
  return async ({ identity, spec, host, workerHost, approval }) => {
    const model = await options.resolveModel(withRoleThinking(spec.model, spec.role));
    const sessionManager = SessionManager.open(
      spec.sessionFile,
      dirname(spec.sessionFile),
      spec.cwd
    );
    let gate: ApprovalGate | undefined;
    const created = await createRoleSession({
      role: spec.role,
      cwd: spec.cwd,
      model,
      sessionManager,
      host,
      workerHost,
      // 没有审批通道时 createRoleSession 自己 fail-closed，也就没有可以切换的审批门
      ...(approval
        ? {
            approval: {
              ...approval,
              onGate: (built: ApprovalGate) => {
                gate = built;
                approval.onGate?.(built);
              },
            },
          }
        : {}),
      resourcePaths: { skills: spec.skills, mcpServers: spec.mcpServers.map(toMcpServerConfig) },
      agentDir: options.agentDir,
      roles: spec.roles,
      settingsManager: createSessionSettings(spec.shellPath),
    });
    const { session } = created;
    options.onModelSelected?.(identity.sessionId, model);
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
      setModel: async (next) => {
        const resolved = await options.resolveModel(withRoleThinking(next, spec.role));
        // pi 先按新模型 clamp 当前档位；再显式设上已按可选集合落定的档位（含 max；不支持推理时没有）
        await session.setModel(resolved.model);
        if (resolved.thinking) session.setThinkingLevel(resolved.thinking);
        options.onModelSelected?.(identity.sessionId, resolved);
      },
      setApprovalMode: (mode) => {
        if (!gate) throw new Error('this session has no approval gate to switch');
        gate.setMode(mode);
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

/** 会话没定思考档位时取角色的 model.thinking（与 createRoleSession 的回落顺序相同），再缺省才是模型的默认档位 */
function withRoleThinking(model: ResolvedModelSpec, role: Role): ResolvedModelSpec {
  const thinking = model.thinking ?? role.model?.thinking;
  return thinking ? { ...model, thinking } : model;
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
