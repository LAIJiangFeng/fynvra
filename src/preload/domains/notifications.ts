import { asRecord, isNonEmptyString } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';

/** 点了通知后要切到的会话（`sessions:focus` 推送）。 */
export interface SessionFocus {
  sessionId: string;
  workspaceId: string;
}

export interface NotificationsApi {
  /** 立即弹一条测试通知 */
  test(): Promise<IpcResult>;
  /** 报告窗口里正看着的会话（没有为 null）：窗口聚焦时这个会话的通知不弹 */
  setViewing(sessionId: string | null): Promise<IpcResult>;
  /** 点了通知：Main 已把窗口拉到前台，Renderer 切到该会话 */
  onFocusSession(callback: (target: SessionFocus) => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createNotificationsApi(ipc: Invoker, subscribe: Subscribe): NotificationsApi {
  return {
    test: () => ipc.invoke(IPC_CHANNELS.NOTIFICATIONS_TEST),
    setViewing: (sessionId) => ipc.invoke(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, { sessionId }),
    onFocusSession: (callback) =>
      subscribe(IPC_CHANNELS.SESSIONS_FOCUS, (target) => {
        const record = asRecord(target);
        const sessionId = record?.sessionId;
        const workspaceId = record?.workspaceId;
        if (isNonEmptyString(sessionId) && isNonEmptyString(workspaceId)) {
          callback({ sessionId, workspaceId });
        }
      }),
  };
}
