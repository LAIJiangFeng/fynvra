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
import { supportsFastMode, withFastServiceTier } from '@shared/modelFast';
import { commandEnvironment } from '@shared/networkProxy';
import type { AgentMcpServer, ResolvedModelSpec } from '@shared/types/agent';
import { type ChatImage, normalizeReplySuggestion } from '@shared/types/chat';
import { createSessionSettings, roleWithShellPrompt } from './shell';
import type { OpenSession } from './supervisor';

/** dispose 前先中止进行中的回合（pi 的 bash 是独立进程组，只在中止时整树结束），最多等这么久 */
const ABORT_BEFORE_DISPOSE_MS = 5_000;

/** 建议请求只带最近几段纯文本，总预算固定；最新的一段优先保留 */
const SUGGESTION_MAX_MESSAGES = 8;
const SUGGESTION_MAX_TOTAL_CHARS = 8_000;
const SUGGESTION_MAX_MESSAGE_CHARS = 2_000;
/**
 * 辅助请求的显式小输出上限。不传 reasoning：Anthropic 的非思考分支不会再加 2048 思考预算，
 * OpenAI 等其他适配器也按各自的非思考 / 模型默认路径处理；辅助请求仍会产生正常 token 费用
 */
const SUGGESTION_MAX_TOKENS = 256;
const SUGGESTION_INSTRUCTION =
  '[suggestion task] Write only the human user’s most likely next message now, or output an empty response.';
const SUGGESTION_SYSTEM_PROMPT = [
  'You predict the next short message the human user will type in the conversation.',
  'Use only the recent conversation; follow the language of the most recent user messages.',
  'Output exactly that next user message: one concise line, no markdown, no quotes, no numbering, no explanations, no multiple options.',
  'Do not answer the assistant’s question or continue the assistant’s reply. Do not repeat or summarize the assistant message. Do not reply with a generic “continue”.',
  'Do not suggest approving destructive or irreversible actions such as deleting, publishing, paying, or changing permissions/roles, unless the user already clearly asked for it.',
  'If no likely user message is evident, output nothing.',
].join(' ');

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

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
      settingsManager: createSessionSettings(spec.shellPath, spec.compactionStrategy),
      ...(spec.networkProxy
        ? {
            commandEnv: (env: NodeJS.ProcessEnv) =>
              commandEnvironment(env, spec.networkProxy, process.platform === 'win32'),
          }
        : {}),
    });
    const { session } = created;
    dropEmptyUserText(session);
    const setFastMode = installFastMode(session, spec.model.fastMode === true);
    // 换模型后建议请求也要用新模型：闭包里保存当前解析结果，不改会话的 thinking / Fast
    let activeModel = model;
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
        // Fast 与模型 / 档位独立：下一次请求起按新切换的值；不支持的协议在请求时也不会带字段
        setFastMode(next.fastMode === true);
        activeModel = resolved;
        options.onModelSelected?.(identity.sessionId, resolved);
      },
      setApprovalMode: (mode) => {
        if (!gate) throw new Error('this session has no approval gate to switch');
        gate.setMode(mode);
      },
      abort: () => session.abort(),
      isIdle: () => session.isIdle,
      suggestReply: ({ signal }) => suggestReply(session, activeModel, signal),
      dispose: async () => {
        if (!session.isIdle) await withTimeout(session.abort(), ABORT_BEFORE_DISPOSE_MS);
        await created.dispose();
      },
    };
  };
}

/**
 * Fast 是每个会话自己的请求选项，不改共享的 provider / model：在 SDK 的 onPayload 上再包一层，
 * 保留扩展的 before_provider_request 变换，只在开关打开且协议支持时补 service_tier。
 * 只包本会话的 agent，并发会话互不影响；关闭或切到不支持的协议后原样返回。
 */
function installFastMode(session: AgentSession, initial: boolean): (enabled: boolean) => void {
  let enabled = initial;
  const original = session.agent.onPayload;
  session.agent.onPayload = async (payload, model) => {
    const next = await original?.(payload, model);
    if (!enabled || !supportsFastMode(model.api)) return next;
    return withFastServiceTier(next === undefined ? payload : next);
  };
  return (value) => {
    enabled = value;
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
 * 独立的辅助生成：直接调 ModelRuntime，不经过 AgentSession.prompt，不写 jsonl、不用工具、不派 worker。
 * 只在这轮已 settle（调用方已确认空闲）且最近有纯文本对话时调用；超时 / 取消 / 任何错误都由调用方当空结果处理。
 */
async function suggestReply(
  session: AgentSession,
  model: ResolvedModel,
  signal: AbortSignal
): Promise<string> {
  if (!session.isIdle) return '';
  const recent = recentConversation(session.messages);
  if (recent.length === 0) return '';
  const answer = await model.runtime.completeSimple(
    model.model,
    {
      systemPrompt: SUGGESTION_SYSTEM_PROMPT,
      messages: [
        ...recent.map(({ role, text }): Message => {
          if (role === 'user') return { role: 'user', content: text, timestamp: 0 };
          return {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: model.model.api,
            provider: model.model.provider,
            model: model.model.id,
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: 0,
          };
        }),
        { role: 'user', content: SUGGESTION_INSTRUCTION, timestamp: 0 },
      ],
    },
    { maxTokens: SUGGESTION_MAX_TOKENS, maxRetries: 0, signal }
  );
  if (answer.stopReason !== 'stop') return '';
  const text = answer.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return normalizeReplySuggestion(text);
}

type PlainConversationMessage = { role: string; content?: unknown };

/**
 * 最近几条 user / assistant 纯文本，按新到旧取到固定预算后再恢复顺序：
 * 最新消息先占预算；assistant 超长保留结论（尾部），user 超长保留开头。工具调用、thinking、图片不进建议上下文。
 */
function recentConversation(
  messages: readonly PlainConversationMessage[]
): { role: 'user' | 'assistant'; text: string }[] {
  const selected: { role: 'user' | 'assistant'; text: string }[] = [];
  let total = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < SUGGESTION_MAX_MESSAGES;
    index--
  ) {
    const message = messages[index];
    if (!message) continue;
    const role =
      message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const text = messageText(message.content).trim();
    if (!text) continue;
    const clipped = clipMessage(text, role === 'assistant');
    const cost = clipped.length + 8;
    if (total + cost > SUGGESTION_MAX_TOTAL_CHARS) break;
    selected.push({ role, text: clipped });
    total += cost;
  }
  return selected.reverse();
}

/** 只取文本块；图片、thinking、工具调用与自定义消息都不算对话正文 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

function clipMessage(text: string, keepTail: boolean): string {
  if (text.length <= SUGGESTION_MAX_MESSAGE_CHARS) return text;
  const slice = keepTail
    ? text.slice(text.length - (SUGGESTION_MAX_MESSAGE_CHARS - 1))
    : text.slice(0, SUGGESTION_MAX_MESSAGE_CHARS - 1);
  return keepTail ? `…${slice}` : `${slice}…`;
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
