import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { TelegramCardAction, TelegramStateView } from '@shared/types/telegram';

export type TelegramStateResult = IpcResult<{ state: TelegramStateView }>;

export interface TelegramApi {
  /** 视图不含 token 明文，只有 tokenMasked */
  getState(): Promise<TelegramStateResult>;
  /** token 明文只在这一跳传给 Main；null 清除 */
  setToken(input: { token: string | null }): Promise<IpcResult>;
  allowGroup(input: { groupId: number; workspaceId: string }): Promise<IpcResult>;
  removeGroup(input: { groupId: number }): Promise<IpcResult>;
  resolveCard(input: { cardId: number; action: TelegramCardAction }): Promise<IpcResult>;
  setEnabled(input: { enabled: boolean }): Promise<IpcResult>;
  /** 每人每小时最多处理几条（1–1000） */
  setRateLimit(input: { perHour: number }): Promise<IpcResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createTelegramApi(ipc: Invoker, subscribe: Subscribe): TelegramApi {
  return {
    getState: () => ipc.invoke(IPC_CHANNELS.TELEGRAM_GET_STATE),
    setToken: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, input),
    allowGroup: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_ALLOW_GROUP, input),
    removeGroup: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_REMOVE_GROUP, input),
    resolveCard: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, input),
    setEnabled: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_SET_ENABLED, input),
    setRateLimit: (input) => ipc.invoke(IPC_CHANNELS.TELEGRAM_SET_RATE_LIMIT, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.TELEGRAM_CHANGED, () => callback()),
  };
}
