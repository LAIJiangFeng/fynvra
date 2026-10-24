import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { ModelEntry, ModelProviderView, ProviderApi } from '@shared/types/llm';

/** `providers:upsert` 入参。apiKey 明文只在这一跳出现：缺省保留已保存的 key，`null` 清除。 */
export interface ProviderUpsertInput {
  /** 缺省为新建，id 由 Main 按名称生成 */
  id?: string;
  name: string;
  api: ProviderApi;
  /** 缺省用协议的官方地址 */
  baseUrl?: string;
  enabled: boolean;
  models: ModelEntry[];
  apiKey?: string | null;
}

export type ProviderListResult = IpcResult<{ providers: ModelProviderView[] }>;
export type ProviderSaveResult = IpcResult<{ provider: ModelProviderView }>;
export type ProviderTestResult = IpcResult<{ latencyMs: number; modelCount?: number }>;

export interface ProvidersApi {
  /** key 已脱敏：只有 hasApiKey 与末 4 位 apiKeyHint */
  list(): Promise<ProviderListResult>;
  upsert(input: ProviderUpsertInput): Promise<ProviderSaveResult>;
  remove(id: string): Promise<IpcResult>;
  /** 用已保存的 key 发一个最小请求（列模型）验证 key 与地址 */
  test(id: string): Promise<ProviderTestResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/**
 * preload/index.ts 传入 ipcRenderer 与订阅函数。本文件不 import electron：preload/types.ts 引用了
 * ProvidersApi，Renderer 的类型程序也会加载本文件，而 electron 的类型会把 Node 全局带进去。
 */
export function createProvidersApi(ipc: Invoker, subscribe: Subscribe): ProvidersApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.PROVIDERS_LIST),
    upsert: (input) => ipc.invoke(IPC_CHANNELS.PROVIDERS_UPSERT, input),
    remove: (id) => ipc.invoke(IPC_CHANNELS.PROVIDERS_REMOVE, id),
    test: (id) => ipc.invoke(IPC_CHANNELS.PROVIDERS_TEST, id),
    onChanged: (callback) => subscribe(IPC_CHANNELS.PROVIDERS_CHANGED, () => callback()),
  };
}
