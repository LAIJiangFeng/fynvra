import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ModelOptions,
  SessionEventEnvelope,
  SessionModelRef,
  SessionSummary,
} from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { Unsubscribe } from '../types';

// ARCHITECTURE §9.3
export interface SessionsApi {
  list(workspaceId: string): Promise<IpcResult<{ sessions: SessionSummary[] }>>;
  create(input: {
    workspaceId: string;
    roleId: string;
    model?: SessionModelRef;
  }): Promise<IpcResult<{ session: SessionSummary }>>;
  remove(sessionId: string): Promise<IpcResult>;
  prompt(input: { sessionId: string; text: string }): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  /** 从 pi jsonl 重建的消息投影；Renderer 切换会话时调用 */
  history(sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>>;
  respondApproval(input: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<IpcResult>;
  /** 换模型 / 思考档位（只传设置里的 id 引用）：会话运行中返回错误；下一次 prompt 起生效 */
  setModel(input: {
    sessionId: string;
    model: SessionModelRef;
  }): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 可选的服务与模型（每个模型带它的思考档位）；传 workspaceId 时带该工作区上一次用过的模型 */
  modelOptions(input?: { workspaceId?: string }): Promise<IpcResult<ModelOptions>>;
  onEvent(cb: (envelope: SessionEventEnvelope) => void): Unsubscribe;
  onSessionsChanged(cb: (workspaceId: string) => void): Unsubscribe;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): Unsubscribe;
}

/**
 * preload 入口交给领域文件的 IPC 能力。本文件不 import electron：它经 preload/types.ts 进入 Renderer 的类型程序，
 * 而 electron 的类型声明带 `/// <reference types="node" />`，会把 Node 全局带进 Renderer。
 */
export interface PreloadIpc {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  /** 回调拿不到 IpcRendererEvent */
  subscribe(channel: string, listener: (...args: unknown[]) => void): Unsubscribe;
}

/** `window.fynvra.sessions`：方法与通道一一对应，Renderer 只传 id 和文本 */
export function createSessionsApi(ipc: PreloadIpc): SessionsApi {
  return {
    list: (workspaceId) => ipc.invoke(IPC_CHANNELS.SESSIONS_LIST, workspaceId),
    create: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_CREATE, input),
    remove: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_REMOVE, sessionId),
    prompt: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_PROMPT, input),
    abort: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_ABORT, sessionId),
    history: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_HISTORY, sessionId),
    respondApproval: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL, input),
    setModel: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_SET_MODEL, input),
    modelOptions: (input = {}) => ipc.invoke(IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, input),
    onEvent: (cb) =>
      ipc.subscribe(IPC_CHANNELS.SESSIONS_EVENT, (envelope) =>
        cb(envelope as SessionEventEnvelope)
      ),
    onSessionsChanged: (cb) =>
      ipc.subscribe(IPC_CHANNELS.SESSIONS_CHANGED, (workspaceId) => cb(String(workspaceId))),
    onApprovalRequest: (cb) =>
      ipc.subscribe(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST, (request) =>
        cb(request as ApprovalRequest)
      ),
  };
}
