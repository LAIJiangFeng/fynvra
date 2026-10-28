import type { ApprovalMode } from '@fynvra/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatImage,
  ChatMessage,
  ModelOptions,
  ReplySuggestion,
  SessionEventEnvelope,
  SessionModelRef,
  SessionSummary,
} from '@shared/types/chat';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { Unsubscribe } from '../types';

// ARCHITECTURE §9.3
export interface SessionsApi {
  /** 默认不含归档的会话；`includeArchived` 时一并列出（带 archivedAt） */
  list(
    workspaceId: string,
    options?: { includeArchived?: boolean }
  ): Promise<IpcResult<{ sessions: SessionSummary[] }>>;
  create(input: {
    workspaceId: string;
    roleId: string;
    model?: SessionModelRef;
  }): Promise<IpcResult<{ session: SessionSummary }>>;
  remove(sessionId: string): Promise<IpcResult>;
  /**
   * 发消息；images 是粘贴的图片（最多 10 张，单张 20 MiB、合计 50 MiB 以内），带图片时 text 可以为空。
   * 有一张图片不合法就整条拒绝
   */
  prompt(input: { sessionId: string; text: string; images?: ChatImage[] }): Promise<IpcResult>;
  /** Steer the running turn right away (pi steer); same input as prompt. Acts as prompt when idle */
  steer(input: { sessionId: string; text: string; images?: ChatImage[] }): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  /** 从 pi jsonl 重建的消息投影；Renderer 切换会话时调用 */
  history(sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>>;
  respondApproval(input: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<IpcResult>;
  /** 换模型 / 思考档位 / Fast（只传设置里的 id 引用）：会话运行中返回错误；下一次 prompt 起生效 */
  setModel(input: {
    sessionId: string;
    model: SessionModelRef;
  }): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 可选的服务与模型（每个模型带它的思考档位）；传 workspaceId 时带该工作区上一次用过的模型 */
  modelOptions(input?: { workspaceId?: string }): Promise<IpcResult<ModelOptions>>;
  /** 换审批档位：运行中也可以，即时生效；会话还没在 worker 里时下次启动用新档位 */
  setApprovalMode(input: {
    sessionId: string;
    mode: ApprovalMode;
  }): Promise<IpcResult<{ session: SessionSummary }>>;
  /**
   * 为刚结束的一轮（`roundId` = settled 事件的会话级 seq）生成一条输入框灰字建议。
   * Renderer 只传会话 id 与轮次 id；Main / worker 再核对空闲状态与轮次，空建议表示没有可展示的建议。
   * 不写入对话历史，不自动发送，失败静默
   */
  suggestReply(input: {
    sessionId: string;
    roundId: number;
  }): Promise<IpcResult<{ suggestion: ReplySuggestion | null }>>;
  /** 归档：运行中返回错误；按设置清理它绑定的、已合并且干净的 worktree */
  archive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 恢复归档的会话，闲置计时从现在重新开始 */
  unarchive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;
  /** 按「通用 → 会话」的设置立即扫一次：归档闲置会话、删除过期的归档 */
  sweep(): Promise<IpcResult<{ archived: number; removed: number }>>;
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

/** `window.fynvra.sessions`：方法与通道一一对应，Renderer 只传 id、文本与粘贴的图片 */
export function createSessionsApi(ipc: PreloadIpc): SessionsApi {
  return {
    list: (workspaceId, options) =>
      ipc.invoke(
        IPC_CHANNELS.SESSIONS_LIST,
        options?.includeArchived ? { workspaceId, includeArchived: true } : workspaceId
      ),
    create: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_CREATE, input),
    remove: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_REMOVE, sessionId),
    prompt: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_PROMPT, input),
    steer: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_STEER, input),
    abort: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_ABORT, sessionId),
    history: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_HISTORY, sessionId),
    respondApproval: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL, input),
    setModel: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_SET_MODEL, input),
    modelOptions: (input = {}) => ipc.invoke(IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, input),
    setApprovalMode: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, input),
    suggestReply: (input) => ipc.invoke(IPC_CHANNELS.SESSIONS_SUGGEST_REPLY, input),
    archive: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_ARCHIVE, sessionId),
    unarchive: (sessionId) => ipc.invoke(IPC_CHANNELS.SESSIONS_UNARCHIVE, sessionId),
    sweep: () => ipc.invoke(IPC_CHANNELS.SESSIONS_SWEEP),
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
