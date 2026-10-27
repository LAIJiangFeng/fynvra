import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type {
  ModelEntry,
  ModelProviderView,
  ProviderApi,
  ProviderImportCandidate,
  ProviderImportSource,
  RemoteModelEntry,
} from '@shared/types/llm';

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

/** `providers:scan-imports` 入参；sources 缺省扫描全部来源 */
export interface ProviderScanImportsInput {
  sources?: ProviderImportSource[];
}
export type ProviderScanImportsResult = IpcResult<{
  candidates: ProviderImportCandidate[];
  /** 读失败、格式不对、缺环境变量等，可直接展示；不含文件原文 */
  warnings: string[];
}>;
/** 选了但没导入的候选及原因（如与已有服务重复） */
export interface ProviderImportSkipped {
  id: string;
  name: string;
  reason: string;
}
/** 导入并拉取模型后的摘要；不含 key、请求地址或服务端原始错误。 */
export interface ProviderImportEntry {
  id: string;
  name: string;
  models: { added: number; total: number } | { error: string };
}
export type ProviderImportResult = IpcResult<{
  imported: ProviderImportEntry[];
  skipped: ProviderImportSkipped[];
}>;

/**
 * `providers:list-remote-models` 入参。已保存的服务传 providerId，key 从 providers.json 取；
 * 还没保存的服务（或表单里改了协议 / 地址、填了新 key）传 draft，apiKey 明文只在这一跳。
 * 两个都传时协议与地址以 draft 为准（draft 没写地址就是协议的官方地址），key 以 draft 优先、没带就用已保存的。
 */
export interface ListRemoteModelsInput {
  providerId?: string;
  draft?: {
    api: ProviderApi;
    /** 缺省用协议的官方地址 */
    baseUrl?: string;
    apiKey?: string;
  };
}
export type ListRemoteModelsResult = IpcResult<{
  /** 按 id 去重、排序 */
  models: RemoteModelEntry[];
  /** 返回这份列表的地址（不含 query） */
  endpoint: string;
  /** 可直接展示的提示：改用了另一种请求形态、跳过 / 略过的条目、列表不完整等；不含 key */
  warnings: string[];
}>;

export interface ProvidersApi {
  /** key 已脱敏：只有 hasApiKey 与末 4 位 apiKeyHint */
  list(): Promise<ProviderListResult>;
  upsert(input: ProviderUpsertInput): Promise<ProviderSaveResult>;
  remove(id: string): Promise<IpcResult>;
  /** 用已保存的 key 发一个最小请求（列模型）验证 key 与地址 */
  test(id: string): Promise<ProviderTestResult>;
  /** 只读扫描本机 Claude Code / Codex / CC Switch 的配置；候选已脱敏，含 key 的结果留在 Main 10 分钟 */
  scanImports(input?: ProviderScanImportsInput): Promise<ProviderScanImportsResult>;
  /** 导入最近一次扫描里的候选并拉取全部远端模型；只传候选 id，key 由 Main 从扫描缓存取 */
  importCandidates(input: { candidateIds: string[] }): Promise<ProviderImportResult>;
  /** 拉取服务端的模型列表，不写盘；加入哪些由界面合并进表单、随保存提交 */
  listRemoteModels(input: ListRemoteModelsInput): Promise<ListRemoteModelsResult>;
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
    scanImports: (input) =>
      input
        ? ipc.invoke(IPC_CHANNELS.PROVIDERS_SCAN_IMPORTS, input)
        : ipc.invoke(IPC_CHANNELS.PROVIDERS_SCAN_IMPORTS),
    importCandidates: (input) => ipc.invoke(IPC_CHANNELS.PROVIDERS_IMPORT, input),
    listRemoteModels: (input) => ipc.invoke(IPC_CHANNELS.PROVIDERS_LIST_REMOTE_MODELS, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.PROVIDERS_CHANGED, () => callback()),
  };
}
