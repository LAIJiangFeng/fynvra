import { join } from 'node:path';
import { isApprovalMode, isThinkingLevel, isValidRoleId } from '@fynvra/core';
import { asRecord, errorMessage } from '@shared/guards';
import { isApprovalDecision } from '@shared/types/agent';
import type {
  ChatMessage,
  ModelOptions,
  SessionModelRef,
  SessionSummary,
} from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { parseWorkspaceId } from '@shared/types/workspace';
import { app, ipcMain } from 'electron';
import {
  type AgentHostService,
  type CreateSessionInput,
  createAgentHost,
  type RespondApprovalInput,
  type SetApprovalModeInput,
  type SetModelInput,
} from '../services/agentHost/agentHost';
import { forkAgentWorker } from '../services/agentHost/electronWorker';
import { createRoleResourceResolver } from '../services/agentHost/roleResources';
import { createShellPathResolver } from '../services/agentHost/shell';
import { toProviderView } from '../services/providers/providerStore';
import { createModelResolver } from '../services/providers/resolveModel';
import { createBranchTracker, readGitBranch } from '../services/sessions/branches';
import { createLastModelStore } from '../services/sessions/lastModels';
import { createSessionStore, parseSessionId } from '../services/sessions/sessionStore';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getMcpRegistry } from './mcp';
import { getProviderStore } from './providers';
import { getRoleStore } from './roles';
import { getSettingsFile } from './settings';
import { getSkillRegistry } from './skills';
import { getWorkspaceService } from './workspaces';

/** 单条 prompt 的上限：挡住异常的超大 IPC 负载 */
export const MAX_PROMPT_CHARS = 1_000_000;
const MAX_REF_CHARS = 200;

let agentHost: AgentHostService | null = null;

/** Main 内唯一的会话 / agent worker 管理者；userData 路径在启动早期才确定，所以延迟创建 */
export function getAgentHost(): AgentHostService {
  agentHost ??= createAppAgentHost();
  return agentHost;
}

function createAppAgentHost(): AgentHostService {
  const userData = app.getPath('userData');
  const agentDir = join(userData, 'agent');
  return createAgentHost({
    fork: () => forkAgentWorker(agentDir),
    agentDir,
    store: createSessionStore({ filePath: join(userData, 'sessions.json') }),
    workspaces: getWorkspaceService(),
    roles: getRoleStore(),
    models: createModelResolver(),
    // 脱敏视图：model-options 不带 key；reasoning 标记也从这里取
    providers: { list: async () => (await getProviderStore().list()).map(toProviderView) },
    lastModels: createLastModelStore(getSettingsFile()),
    branches: createBranchTracker({ read: (cwd) => readGitBranch(cwd) }),
    resolveResources: createRoleResourceResolver({
      skills: getSkillRegistry(),
      mcpServers: getMcpRegistry(),
    }),
    resolveShellPath: createShellPathResolver({ settings: getSettingsFile() }),
    broadcast: sendToAllWindows,
  });
}

/** 注册 `sessions:*` handler。入参一律按 unknown 收窄，Renderer 只能传 id，不能传路径。 */
export function registerSessionHandlers(host: () => AgentHostService = getAgentHost): void {
  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_LIST,
    (_event, raw: unknown): IpcResult<{ sessions: SessionSummary[] }> => {
      const workspaceId = parseWorkspaceId(raw);
      if (!workspaceId) return { ok: false, error: '无效的工作区 id' };
      try {
        return { ok: true, sessions: host().list(workspaceId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.SESSIONS_CREATE, (_event, raw: unknown) => {
    const input = parseCreateSessionInput(raw);
    return input ? guard(() => host().create(input)) : invalid('无效的会话参数');
  });

  ipcMain.handle(IPC_CHANNELS.SESSIONS_REMOVE, (_event, raw: unknown) =>
    withSessionId(raw, (sessionId) => host().remove(sessionId))
  );

  ipcMain.handle(IPC_CHANNELS.SESSIONS_PROMPT, (_event, raw: unknown) => {
    const input = parsePromptInput(raw);
    return input ? guard(() => host().prompt(input.sessionId, input.text)) : invalid('无效的消息');
  });

  ipcMain.handle(IPC_CHANNELS.SESSIONS_ABORT, (_event, raw: unknown) =>
    withSessionId(raw, (sessionId) => host().abort(sessionId))
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_HISTORY,
    (_event, raw: unknown): Promise<IpcResult<{ messages: ChatMessage[] }>> =>
      withSessionId(raw, (sessionId) => host().history(sessionId))
  );

  ipcMain.handle(IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL, (_event, raw: unknown) => {
    const input = parseRespondApprovalInput(raw);
    return input ? guard(() => host().respondApproval(input)) : invalid('无效的审批结果');
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_SET_MODEL,
    (_event, raw: unknown): Promise<IpcResult<{ session: SessionSummary }>> => {
      const input = parseSetModelInput(raw);
      return input ? guard(() => host().setModel(input)) : invalid('无效的模型参数');
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_MODEL_OPTIONS,
    (_event, raw: unknown): Promise<IpcResult<ModelOptions>> => {
      const input = parseModelOptionsInput(raw);
      return input ? guard(() => host().modelOptions(input)) : invalid('无效的参数');
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE,
    (_event, raw: unknown): Promise<IpcResult<{ session: SessionSummary }>> => {
      const input = parseSetApprovalModeInput(raw);
      return input ? guard(() => host().setApprovalMode(input)) : invalid('无效的审批档位');
    }
  );

  // 用户可能在外部终端里切过分支：窗口重新获得焦点时重读（按目录节流，有变化才广播 sessions:changed）
  app.on('browser-window-focus', () => {
    try {
      host().refreshBranches();
    } catch (error) {
      console.warn('[sessions] 重读会话分支失败', error);
    }
  });
}

/** `{ workspaceId, roleId, model? }`，不接受其他字段（尤其是 cwd / 路径） */
export function parseCreateSessionInput(raw: unknown): CreateSessionInput | null {
  const record = strictRecord(raw, ['workspaceId', 'roleId', 'model']);
  if (!record) return null;
  const workspaceId = parseWorkspaceId(record.workspaceId);
  const { roleId } = record;
  if (!workspaceId || !isValidRoleId(roleId)) return null;
  if (record.model === undefined) return { workspaceId, roleId };
  const model = parseModelRef(record.model);
  return model ? { workspaceId, roleId, model } : null;
}

/** `{ sessionId, model: { providerId, modelId, thinking? } }`：只有设置里的 id 引用，不带地址或 key */
export function parseSetModelInput(raw: unknown): SetModelInput | null {
  const record = strictRecord(raw, ['sessionId', 'model']);
  const sessionId = parseSessionId(record?.sessionId);
  const model = parseModelRef(record?.model);
  return sessionId && model ? { sessionId, model } : null;
}

/** `{ sessionId, mode }`：mode 只能是三档之一（大小写敏感） */
export function parseSetApprovalModeInput(raw: unknown): SetApprovalModeInput | null {
  const record = strictRecord(raw, ['sessionId', 'mode']);
  const sessionId = parseSessionId(record?.sessionId);
  const mode = record?.mode;
  return sessionId && isApprovalMode(mode) ? { sessionId, mode } : null;
}

/** 无参或 `{ workspaceId? }` */
export function parseModelOptionsInput(raw: unknown): { workspaceId?: string } | null {
  if (raw === undefined) return {};
  const record = strictRecord(raw, ['workspaceId']);
  if (!record) return null;
  if (record.workspaceId === undefined) return {};
  const workspaceId = parseWorkspaceId(record.workspaceId);
  return workspaceId ? { workspaceId } : null;
}

function parseModelRef(raw: unknown): SessionModelRef | null {
  const model = strictRecord(raw, ['providerId', 'modelId', 'thinking']);
  if (!model || !isRef(model.providerId) || !isRef(model.modelId)) return null;
  const { providerId, modelId, thinking } = model;
  if (thinking !== undefined && !isThinkingLevel(thinking)) return null;
  return { providerId, modelId, ...(thinking !== undefined ? { thinking } : {}) };
}

/** `{ sessionId, text }`：文本不能全是空白，长度有上限，原样保留（不 trim） */
export function parsePromptInput(raw: unknown): { sessionId: string; text: string } | null {
  const record = strictRecord(raw, ['sessionId', 'text']);
  const sessionId = parseSessionId(record?.sessionId);
  const text = record?.text;
  if (!sessionId || typeof text !== 'string' || !text.trim()) return null;
  return text.length <= MAX_PROMPT_CHARS ? { sessionId, text } : null;
}

export function parseRespondApprovalInput(raw: unknown): RespondApprovalInput | null {
  const record = strictRecord(raw, ['sessionId', 'requestId', 'decision']);
  const sessionId = parseSessionId(record?.sessionId);
  const requestId = record?.requestId;
  const decision = record?.decision;
  if (!sessionId || !isRef(requestId) || !isApprovalDecision(decision)) return null;
  return { sessionId, requestId, decision };
}

/** 只含允许的键（缺省可以）的普通对象 */
function strictRecord<K extends string>(
  raw: unknown,
  allowed: readonly K[]
): Partial<Record<K, unknown>> | null {
  const record = asRecord(raw);
  if (!record) return null;
  return Object.keys(record).every((key) => (allowed as readonly string[]).includes(key))
    ? (record as Partial<Record<K, unknown>>)
    : null;
}

function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_REF_CHARS;
}

function invalid<T extends object = object>(error: string): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error });
}

function withSessionId<T extends object>(
  raw: unknown,
  run: (sessionId: string) => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  const sessionId = parseSessionId(raw);
  return sessionId
    ? guard(() => run(sessionId))
    : Promise.resolve({ ok: false, error: '无效的会话 id' });
}

/** handler 不跨边界抛异常 */
async function guard<T extends object>(run: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
