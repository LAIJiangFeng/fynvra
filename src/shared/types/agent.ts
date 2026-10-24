import {
  type FynvraSessionEvent,
  type FynvraSessionEventBody,
  isThinkingLevel,
  parseRole,
  type Role,
  type ThinkingLevel,
} from '@fynvra/core';
import { asRecord, isNonEmptyString } from '../guards';
import type {
  ApprovalDecision,
  ApprovalKind,
  ModelThinkingCapability,
  SessionStatus,
} from './chat';

/**
 * Main ⇄ Agent Worker（utilityProcess，`src/agent`）的消息协议（ARCHITECTURE §3）。
 * 两端收到的消息一律先经本文件的 parser 按 `unknown` 收窄：类型不认识或字段不合法的整条丢弃。
 */

/**
 * 会话身份。Main 每次在 worker 里（重新）创建会话都换一个更大的 generation，
 * 两端都丢弃过期 generation 的消息（如崩溃重启前的残留事件、已关闭会话的 host 调用）。
 */
export interface SessionIdentity {
  sessionId: string;
  generation: number;
}

/** 跨进程可序列化的模型描述（ARCHITECTURE §9.5）；worker 进程内再换成 agent-runtime 的 ResolvedModel。 */
export interface ResolvedModelSpec {
  providerId: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  thinking?: ThinkingLevel;
  /** 设置里模型条目的 reasoning 标记：只对 pi 内置目录里没有的模型生效，目录里有的以目录为准 */
  reasoning?: boolean;
}

/** describe-models 的一项：按协议与模型 id 在 pi 内置目录里找，目录里没有时按 reasoning 标记 */
export interface ModelQuery {
  api: string;
  modelId: string;
  reasoning?: boolean;
}

/** models-described 的结果：成功时与 describe-models 的 models 一一对应、顺序相同 */
export type ModelsDescribedResult =
  | { ok: true; models: ModelThinkingCapability[] }
  | { ok: false; error: string };

/** 角色挂载的 MCP 服务器（Main 已解析；env / headers 明文只在 Main → worker 这一跳出现）。 */
export interface AgentMcpServer {
  name: string;
  /** stdio 服务器 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP 服务器 */
  url?: string;
  headers?: Record<string, string>;
}

/** dispatch_task 可选的角色（与 agent-runtime 的 RoleOption 同形）。 */
export interface AgentRoleOption {
  id: string;
  name: string;
  description?: string;
}

/** `spawn-session` 的会话参数：全部由 Main 解析好，worker 不读任何 Main 的存储。 */
export interface SpawnSessionSpec {
  role: Role;
  /** 会话工作目录：工作区仓库根或 worktree（Main 由记录推导） */
  cwd: string;
  /** pi 会话 jsonl 的绝对路径（Main 决定；不存在时新建，存在时续写） */
  sessionFile: string;
  /** API key 只在这一跳从 Main 交给 worker */
  model: ResolvedModelSpec;
  /** 已解析的 skill 目录或 SKILL.md 路径 */
  skills: string[];
  mcpServers: AgentMcpServer[];
  /** 由编排派发的 worker 会话：加 ask_coordinator / report_done，背后是 Main 的 WorkerHost */
  worker: boolean;
  /** dispatch_task 的角色枚举（orchestrator 策略的会话用） */
  roles: AgentRoleOption[];
  /**
   * bash 工具用的 shell（Main 解析：settings.json 的 `preferences.shellPath`，或 Windows 上探测到的 Git Bash）；
   * 缺省时由 pi 自己找，Windows 上可能取到 PATH 上的 WSL bash.exe
   */
  shellPath?: string;
}

/** host-invoke 的目标：编排工具背后的 OrchestrationHost，或 worker 工具背后的 WorkerHost。 */
export type HostKind = 'orchestration' | 'worker';

/** Host 调用结果的线上形态（agent-runtime 的 HostResult）：失败带 error，成功时其余字段原样透传。 */
export type HostCallResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string };

export type LogLevel = 'info' | 'warn' | 'error';

/** 待审批请求的有效期：worker 超时按 deny 处理，Main 据此给出 ApprovalRequest.expiresAt。 */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * 审批门挂起的一次工具调用（worker 侧 agent-runtime 已分类并生成展示文本）。
 * Main 不加载 agent-runtime，审批条的 kind / title / detail 一律以这里为准。
 */
export interface AgentApprovalRequest {
  requestId: string;
  toolCallId: string;
  toolName: string;
  kind: ApprovalKind;
  title: string;
  /** 命令全文 / 文件路径 / 参数预览 */
  detail: string;
  /** 命中的保护底线（如 `git push`）：任何档位都要人确认 */
  protectedAction?: string;
  /** epoch ms：worker 到期按 deny 结束 */
  expiresAt: number;
}

/** Main → worker。 */
export type AgentCommand =
  | { type: 'spawn-session'; identity: SessionIdentity; spec: SpawnSessionSpec }
  /** 会话运行中到达时排到当前回合之后（followUp） */
  | { type: 'prompt'; identity: SessionIdentity; text: string }
  /** 会话运行中插话（当前工具调用结束后送达）；空闲时等同 prompt */
  | { type: 'steer'; identity: SessionIdentity; text: string }
  | { type: 'abort'; identity: SessionIdentity }
  | { type: 'dispose-session'; identity: SessionIdentity }
  | {
      type: 'respond-approval';
      identity: SessionIdentity;
      requestId: string;
      decision: ApprovalDecision;
    }
  /** Main 回传 OrchestrationHost / WorkerHost 的调用结果 */
  | { type: 'host-result'; identity: SessionIdentity; callId: string; result: HostCallResult }
  /**
   * 换会话的模型 / 思考档位（spec 同 spawn-session）：worker 先注册 provider 再调 pi 的 setModel，
   * 下一次 prompt 起生效，pi 的会话历史保留
   */
  | { type: 'set-model'; identity: SessionIdentity; model: ResolvedModelSpec }
  /** 查模型的思考档位（进程级，不带 identity）；worker 回同一 requestId 的 models-described */
  | { type: 'describe-models'; requestId: string; models: ModelQuery[] }
  /** 关闭全部会话后退出进程（进程级，不带 identity） */
  | { type: 'shutdown' };

/** worker → Main。 */
export type AgentWorkerEvent =
  /** 已接上 parentPort，可以接收命令（进程级） */
  | { type: 'ready' }
  /** `seq` 按 identity 从 1 递增，与 `event.seq` 相同 */
  | { type: 'session-event'; identity: SessionIdentity; seq: number; event: FynvraSessionEvent }
  | { type: 'session-status'; identity: SessionIdentity; status: SessionStatus }
  | {
      type: 'host-invoke';
      identity: SessionIdentity;
      callId: string;
      kind: HostKind;
      method: string;
      input: unknown;
    }
  /** 调用方已放弃（工具被中止或等待超时），Main 应中止对应的 host 调用 */
  | { type: 'host-cancel'; identity: SessionIdentity; callId: string }
  /**
   * 审批门在等人确认：Main 记下待审批并推 `sessions:approval-request`。
   * 紧接着还有同一 requestId 的 approval_request 会话事件，供时间线关联工具调用。
   */
  | { type: 'approval-request'; identity: SessionIdentity; request: AgentApprovalRequest }
  /** `fatal`：worker 已不再持有该会话（如创建失败），下次使用前 Main 必须重新 spawn */
  | { type: 'session-error'; identity: SessionIdentity; error: string; fatal: boolean }
  /** describe-models 的回答（进程级） */
  | { type: 'models-described'; requestId: string; result: ModelsDescribedResult }
  /** 诊断日志（进程级） */
  | { type: 'log'; level: LogLevel; message: string };

// Record 键强制穷举联合类型：chat.ts / core 加了成员而这里没加会编译失败。
const SESSION_STATUS_SET: Record<SessionStatus, true> = {
  idle: true,
  running: true,
  'waiting-approval': true,
  error: true,
};
const APPROVAL_DECISION_SET: Record<ApprovalDecision, true> = {
  allow: true,
  allowSession: true,
  deny: true,
};
const APPROVAL_KIND_SET: Record<ApprovalKind, true> = {
  command: true,
  'file-edit': true,
  'file-write': true,
  mcp: true,
};
const HOST_KIND_SET: Record<HostKind, true> = { orchestration: true, worker: true };
const LOG_LEVEL_SET: Record<LogLevel, true> = { info: true, warn: true, error: true };

function memberOf<T extends string>(set: Record<T, true>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(set, value);
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return memberOf(SESSION_STATUS_SET, value);
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return memberOf(APPROVAL_DECISION_SET, value);
}

/** Main → worker 消息收窄；不合法返回 null。 */
export function parseAgentCommand(raw: unknown): AgentCommand | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.type === 'shutdown') return { type: 'shutdown' };
  if (record.type === 'describe-models') {
    const models = parseList(record.models, parseModelQuery);
    return isNonEmptyString(record.requestId) && models
      ? { type: 'describe-models', requestId: record.requestId, models }
      : null;
  }
  const identity = parseIdentity(record.identity);
  if (!identity) return null;
  switch (record.type) {
    case 'spawn-session': {
      const spec = parseSpawnSessionSpec(record.spec);
      return spec ? { type: 'spawn-session', identity, spec } : null;
    }
    case 'set-model': {
      const model = parseModelSpec(record.model);
      return model ? { type: 'set-model', identity, model } : null;
    }
    case 'prompt':
      return isNonEmptyString(record.text) ? { type: 'prompt', identity, text: record.text } : null;
    case 'steer':
      return isNonEmptyString(record.text) ? { type: 'steer', identity, text: record.text } : null;
    case 'abort':
      return { type: 'abort', identity };
    case 'dispose-session':
      return { type: 'dispose-session', identity };
    case 'respond-approval': {
      const { requestId, decision } = record;
      if (!isNonEmptyString(requestId) || !isApprovalDecision(decision)) return null;
      return { type: 'respond-approval', identity, requestId, decision };
    }
    case 'host-result': {
      const result = parseHostCallResult(record.result);
      if (!isNonEmptyString(record.callId) || !result) return null;
      return { type: 'host-result', identity, callId: record.callId, result };
    }
    default:
      return null;
  }
}

/** worker → Main 消息收窄；不合法返回 null。 */
export function parseAgentWorkerEvent(raw: unknown): AgentWorkerEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.type === 'ready') return { type: 'ready' };
  if (record.type === 'log') {
    const { level, message } = record;
    return memberOf(LOG_LEVEL_SET, level) && typeof message === 'string'
      ? { type: 'log', level, message }
      : null;
  }
  if (record.type === 'models-described') {
    const result = parseModelsDescribedResult(record.result);
    return isNonEmptyString(record.requestId) && result
      ? { type: 'models-described', requestId: record.requestId, result }
      : null;
  }
  const identity = parseIdentity(record.identity);
  if (!identity) return null;
  switch (record.type) {
    case 'session-event': {
      const { seq } = record;
      const event = parseSessionEvent(record.event);
      if (!isPositiveInteger(seq) || !event || event.seq !== seq) return null;
      return { type: 'session-event', identity, seq, event };
    }
    case 'session-status':
      return isSessionStatus(record.status)
        ? { type: 'session-status', identity, status: record.status }
        : null;
    case 'host-invoke': {
      const { callId, kind, method } = record;
      if (!isNonEmptyString(callId) || !memberOf(HOST_KIND_SET, kind)) return null;
      if (!isNonEmptyString(method)) return null;
      return { type: 'host-invoke', identity, callId, kind, method, input: record.input };
    }
    case 'host-cancel':
      return isNonEmptyString(record.callId)
        ? { type: 'host-cancel', identity, callId: record.callId }
        : null;
    case 'session-error': {
      const { error, fatal } = record;
      return typeof error === 'string' && typeof fatal === 'boolean'
        ? { type: 'session-error', identity, error, fatal }
        : null;
    }
    case 'approval-request': {
      const request = parseApprovalRequest(record.request);
      return request ? { type: 'approval-request', identity, request } : null;
    }
    default:
      return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 可选字段：缺省（undefined）放行，有值时必须通过 guard（null 也不合法）。 */
function isOptional<T>(value: unknown, guard: (value: unknown) => value is T): boolean {
  return value === undefined || guard(value);
}

function parseIdentity(raw: unknown): SessionIdentity | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { sessionId, generation } = record;
  return isNonEmptyString(sessionId) && isPositiveInteger(generation)
    ? { sessionId, generation }
    : null;
}

function parseApprovalRequest(raw: unknown): AgentApprovalRequest | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { requestId, toolCallId, toolName, kind, title, detail, protectedAction, expiresAt } =
    record;
  if (!isNonEmptyString(requestId) || !isString(toolCallId) || !isNonEmptyString(toolName)) {
    return null;
  }
  if (!memberOf(APPROVAL_KIND_SET, kind) || !isString(title) || !isString(detail)) return null;
  if (!isOptional(protectedAction, isString)) return null;
  if (!isFiniteNumber(expiresAt) || expiresAt <= 0) return null;
  return {
    requestId,
    toolCallId,
    toolName,
    kind,
    title,
    detail,
    ...(protectedAction !== undefined ? { protectedAction: protectedAction as string } : {}),
    expiresAt,
  };
}

function parseHostCallResult(raw: unknown): HostCallResult | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.ok === true) return { ...record, ok: true };
  if (record.ok === false && isString(record.error)) return { ok: false, error: record.error };
  return null;
}

function parseStringList(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every(isString) ? [...raw] : null;
}

function parseStringMap(raw: unknown): Record<string, string> | null {
  const record = asRecord(raw);
  if (!record || !Object.values(record).every(isString)) return null;
  return { ...(record as Record<string, string>) };
}

/** 列表里任一元素不合法，整个列表作废。 */
function parseList<T>(raw: unknown, parseItem: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const items: T[] = [];
  for (const entry of raw) {
    const item = parseItem(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function parseModelSpec(raw: unknown): ResolvedModelSpec | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { providerId, api, baseUrl, apiKey, modelId, thinking, reasoning } = record;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(api) || !isNonEmptyString(modelId)) {
    return null;
  }
  if (!isOptional(baseUrl, isNonEmptyString) || !isOptional(apiKey, isNonEmptyString)) return null;
  if (!isOptional(thinking, isThinkingLevel) || !isOptional(reasoning, isBoolean)) return null;
  return {
    providerId,
    api,
    modelId,
    ...(baseUrl !== undefined ? { baseUrl: baseUrl as string } : {}),
    ...(apiKey !== undefined ? { apiKey: apiKey as string } : {}),
    ...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
    ...(reasoning !== undefined ? { reasoning: reasoning as boolean } : {}),
  };
}

function parseModelQuery(raw: unknown): ModelQuery | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { api, modelId, reasoning } = record;
  if (!isNonEmptyString(api) || !isNonEmptyString(modelId)) return null;
  if (!isOptional(reasoning, isBoolean)) return null;
  return { api, modelId, ...(reasoning !== undefined ? { reasoning: reasoning as boolean } : {}) };
}

/** 档位不重复、都是 fynvra 认识的；默认档位必须在可选集合里 */
function parseThinkingCapability(raw: unknown): ModelThinkingCapability | null {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.thinkingLevels)) return null;
  const levels: unknown[] = record.thinkingLevels;
  if (!levels.every(isThinkingLevel) || new Set(levels).size !== levels.length) return null;
  const thinkingLevels = [...levels] as ThinkingLevel[];
  const { defaultThinking } = record;
  if (defaultThinking === undefined) return { thinkingLevels };
  if (!isThinkingLevel(defaultThinking) || !thinkingLevels.includes(defaultThinking)) return null;
  return { thinkingLevels, defaultThinking };
}

function parseModelsDescribedResult(raw: unknown): ModelsDescribedResult | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.ok === false)
    return isString(record.error) ? { ok: false, error: record.error } : null;
  if (record.ok !== true) return null;
  const models = parseList(record.models, parseThinkingCapability);
  return models ? { ok: true, models } : null;
}

function parseMcpServer(raw: unknown): AgentMcpServer | null {
  const record = asRecord(raw);
  if (!record || !isNonEmptyString(record.name)) return null;
  const { command, url } = record;
  if (!isOptional(command, isNonEmptyString) || !isOptional(url, isNonEmptyString)) return null;
  if (command === undefined && url === undefined) return null;
  const server: AgentMcpServer = { name: record.name };
  if (command !== undefined) server.command = command as string;
  if (url !== undefined) server.url = url as string;
  if (record.args !== undefined) {
    const args = parseStringList(record.args);
    if (!args) return null;
    server.args = args;
  }
  for (const key of ['env', 'headers'] as const) {
    if (record[key] === undefined) continue;
    const map = parseStringMap(record[key]);
    if (!map) return null;
    server[key] = map;
  }
  return server;
}

function parseRoleOption(raw: unknown): AgentRoleOption | null {
  const record = asRecord(raw);
  if (!record || !isNonEmptyString(record.id) || !isNonEmptyString(record.name)) return null;
  const { description } = record;
  if (!isOptional(description, isString)) return null;
  return {
    id: record.id,
    name: record.name,
    ...(description !== undefined ? { description: description as string } : {}),
  };
}

function parseSpawnSessionSpec(raw: unknown): SpawnSessionSpec | null {
  const record = asRecord(raw);
  if (!record) return null;
  const role = parseRole(record.role);
  const model = parseModelSpec(record.model);
  const skills = parseStringList(record.skills);
  const mcpServers = parseList(record.mcpServers, parseMcpServer);
  const roles = parseList(record.roles, parseRoleOption);
  const { cwd, sessionFile, worker, shellPath } = record;
  if (!role.ok || !model || !skills || !mcpServers || !roles) return null;
  if (!isNonEmptyString(cwd) || !isNonEmptyString(sessionFile) || typeof worker !== 'boolean') {
    return null;
  }
  if (!isOptional(shellPath, isNonEmptyString)) return null;
  return {
    role: role.role,
    cwd,
    sessionFile,
    model,
    skills,
    mcpServers,
    worker,
    roles,
    ...(shellPath !== undefined ? { shellPath: shellPath as string } : {}),
  };
}

type EventBodyParsers = {
  [K in FynvraSessionEventBody['type']]: (
    record: Record<string, unknown>
  ) => Extract<FynvraSessionEventBody, { type: K }> | null;
};

// 映射类型强制穷举：core 新增事件变体而这里没加解析会编译失败。
const EVENT_BODY_PARSERS: EventBodyParsers = {
  text_delta: ({ delta }) => (isString(delta) ? { type: 'text_delta', delta } : null),
  thinking_delta: ({ delta }) => (isString(delta) ? { type: 'thinking_delta', delta } : null),
  tool_start: ({ toolCallId, toolName, args, parentToolCallId }) => {
    if (!isString(toolCallId) || !isString(toolName)) return null;
    if (!isOptional(parentToolCallId, isString)) return null;
    return {
      type: 'tool_start',
      toolCallId,
      toolName,
      args,
      ...(parentToolCallId !== undefined ? { parentToolCallId: parentToolCallId as string } : {}),
    };
  },
  tool_end: (record) => {
    const { toolCallId, toolName, isError, output, outputTruncated } = record;
    const { durationMs, parentToolCallId } = record;
    if (!isString(toolCallId) || !isString(toolName) || !isString(output)) return null;
    if (typeof isError !== 'boolean' || typeof outputTruncated !== 'boolean') return null;
    if (!isOptional(durationMs, isFiniteNumber) || !isOptional(parentToolCallId, isString)) {
      return null;
    }
    return {
      type: 'tool_end',
      toolCallId,
      toolName,
      isError,
      output,
      outputTruncated,
      ...(durationMs !== undefined ? { durationMs: durationMs as number } : {}),
      ...(parentToolCallId !== undefined ? { parentToolCallId: parentToolCallId as string } : {}),
    };
  },
  message_end: ({ role, text, stopReason, errorMessage }) => {
    if ((role !== 'user' && role !== 'assistant') || !isString(text)) return null;
    if (!isOptional(stopReason, isString) || !isOptional(errorMessage, isString)) return null;
    return {
      type: 'message_end',
      role,
      text,
      ...(stopReason !== undefined ? { stopReason: stopReason as string } : {}),
      ...(errorMessage !== undefined ? { errorMessage: errorMessage as string } : {}),
    };
  },
  agent_settled: ({ aborted }) =>
    typeof aborted === 'boolean' ? { type: 'agent_settled', aborted } : null,
  approval_request: ({ requestId, toolCallId, toolName, args, reason }) => {
    if (!isNonEmptyString(requestId) || !isString(toolCallId) || !isString(toolName)) return null;
    if (!isOptional(reason, isString)) return null;
    return {
      type: 'approval_request',
      requestId,
      toolCallId,
      toolName,
      args,
      ...(reason !== undefined ? { reason: reason as string } : {}),
    };
  },
  usage: (record) => {
    const { provider, model, input, output, cacheRead, cacheWrite, totalTokens, cost } = record;
    if (!isString(provider) || !isString(model)) return null;
    const numbers = [input, output, cacheRead, cacheWrite, totalTokens, cost];
    if (!numbers.every(isFiniteNumber)) return null;
    return {
      type: 'usage',
      provider,
      model,
      input: input as number,
      output: output as number,
      cacheRead: cacheRead as number,
      cacheWrite: cacheWrite as number,
      totalTokens: totalTokens as number,
      cost: cost as number,
    };
  },
  error: ({ source, message }) => {
    if (source !== 'model' && source !== 'compaction' && source !== 'host') return null;
    return isString(message) ? { type: 'error', source, message } : null;
  },
};

function parseSessionEvent(raw: unknown): FynvraSessionEvent | null {
  const record = asRecord(raw);
  if (!record || !isPositiveInteger(record.seq)) return null;
  const { type } = record;
  if (typeof type !== 'string' || !Object.hasOwn(EVENT_BODY_PARSERS, type)) return null;
  const parse = EVENT_BODY_PARSERS[type as FynvraSessionEventBody['type']] as (
    record: Record<string, unknown>
  ) => FynvraSessionEventBody | null;
  const body = parse(record);
  return body ? { ...body, seq: record.seq } : null;
}
