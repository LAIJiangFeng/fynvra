import {
  type AppMessageBoxReply,
  type AppMessageBoxRequest,
  parseAppMessageBoxRequest,
} from '@shared/types/appDialog';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { Unsubscribe } from '../types';

/** Main 发起、由应用内对话框显示的提示框。 */
export interface AppDialogApi {
  /** Main 请求显示提示框；不合法的请求直接丢弃（Main 收不到 ack 会回退原生对话框） */
  onRequest(callback: (request: AppMessageBoxRequest) => void): Unsubscribe;
  /** 确认已接手显示；返回 ok: false 表示请求已过期（Main 已回退原生），不要再显示 */
  shown(requestId: string): Promise<IpcResult>;
  /** 回复用户的选择 */
  respond(reply: AppMessageBoxReply): Promise<IpcResult>;
}

export function createAppDialogApi(
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> },
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => Unsubscribe
): AppDialogApi {
  return {
    onRequest: (callback) =>
      subscribe(IPC_CHANNELS.APP_DIALOG_REQUEST, (raw) => {
        const request = parseAppMessageBoxRequest(raw);
        if (request) callback(request);
      }),
    shown: (requestId) =>
      ipc.invoke(IPC_CHANNELS.APP_DIALOG_SHOWN, requestId) as Promise<IpcResult>,
    respond: (reply) =>
      ipc.invoke(IPC_CHANNELS.APP_DIALOG_RESPOND, {
        requestId: reply.requestId,
        response: reply.response,
      }) as Promise<IpcResult>,
  };
}
