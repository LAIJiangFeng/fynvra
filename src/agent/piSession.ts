import { dirname } from 'node:path';
import type { ImageContent, Message } from '@earendil-works/pi-ai';
import { type AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import {
  type ApprovalGate,
  createRoleSession,
  type McpServerConfig,
  type ResolvedModel,
  subscribeNormalized,
} from '@fynvra/agent-runtime';
import type { Role } from '@fynvra/core';
import type { AgentMcpServer, ResolvedModelSpec } from '@shared/types/agent';
import type { ChatImage } from '@shared/types/chat';
import { createSessionSettings, roleWithShellPrompt } from './shell';
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
      role: roleWithShellPrompt(spec.role, spec.shellPath),
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
      resourcePaths: {
        skills: spec.skills,
        mcpServers: spec.mcpServers.map(toMcpServerConfig),
        ...(spec.instructionFile ? { instructionFile: spec.instructionFile } : {}),
      },
      agentDir: options.agentDir,
      roles: spec.roles,
      ...(spec.inPlace ? { inPlace: true } : {}),
      settingsManager: createSessionSettings(spec.shellPath),
    });
    const { session } = created;
    dropEmptyUserText(session);
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
      prompt: (text, images) =>
        session.prompt(text, {
          streamingBehavior: 'followUp',
          ...(images?.length ? { images: images.map(toImageContent) } : {}),
        }),
      steer: async (text, images) => {
        await session.steer(text, images?.length ? images.map(toImageContent) : undefined);
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

/** 粘贴的图片 → pi 的 ImageContent（缩放、转 PNG 由 pi 的 prompt 自己做） */
function toImageContent({ data, mimeType }: ChatImage): ImageContent {
  return { type: 'image', data, mimeType };
}

/**
 * 只有图片、没有文字的 user 消息，pi 照样在图片前放一个空的 text 块（jsonl 里也这样记）。
 * Anthropic、OpenAI Chat Completions 的消息转换会滤掉空文本块，OpenAI Responses、Google 的不滤，
 * 而 Gemini 拒绝空的 text part；这条消息之后每一轮都在上下文里，一旦被拒，整个会话都发不出去。
 * 所以在 pi 把消息交给 provider 之前（agent 的 convertToLlm）去掉 user 消息里的空文本块；
 * 只有空文本的消息原样保留，不造出没有内容的消息。
 */
function dropEmptyUserText(session: AgentSession): void {
  const { agent } = session;
  const convert = agent.convertToLlm.bind(agent);
  agent.convertToLlm = async (messages) => withoutEmptyUserText(await convert(messages));
}

function withoutEmptyUserText(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;
    const content = message.content.filter(
      (block) => block.type !== 'text' || block.text.trim() !== ''
    );
    return content.length === message.content.length || content.length === 0
      ? message
      : { ...message, content };
  });
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
