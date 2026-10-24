import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { McpServerEntry, McpServerEntryView } from '@shared/types/llm';

/** env / headers 的一项。value 缺省表示沿用已保存的值（编辑时 Renderer 拿不到明文）。 */
export interface SecretFieldInput {
  key: string;
  value?: string;
}

/** `mcp:upsert` 入参。env / headers 明文只在这一跳出现。 */
export interface McpUpsertInput {
  /** 缺省为新建，id 由 Main 按名称生成 */
  id?: string;
  name: string;
  transport: McpServerEntry['transport'];
  /** stdio 必填 */
  command?: string;
  args?: string[];
  /** sse / http 必填 */
  url?: string;
  enabled: boolean;
  /** 仅 stdio。缺省：沿用已保存的全部项；给出时就是完整的键集合 */
  env?: SecretFieldInput[];
  /** 仅 sse / http，规则同 env */
  headers?: SecretFieldInput[];
}

export interface McpImportSource {
  /** 仅供展示 */
  file: string;
  status: 'found' | 'not-found' | 'error';
  count: number;
  error?: string;
}

export type McpListResult = IpcResult<{ servers: McpServerEntryView[] }>;
export type McpSaveResult = IpcResult<{ server: McpServerEntryView }>;
export type McpImportResult = IpcResult<{
  added: McpServerEntryView[];
  /** 与已登记或本次已导入的服务器重复（命令+参数 / URL 相同）而跳过的数量 */
  skipped: number;
  sources: McpImportSource[];
}>;

export interface McpApi {
  /** env / headers 只给键名 */
  list(): Promise<McpListResult>;
  upsert(input: McpUpsertInput): Promise<McpSaveResult>;
  remove(id: string): Promise<IpcResult>;
  toggle(input: { id: string; enabled: boolean }): Promise<McpSaveResult>;
  /** 导入 ~/.claude.json 与 ~/.claude/settings.json 的 mcpServers，按命令+参数 / URL 去重 */
  importClaude(): Promise<McpImportResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createMcpApi(ipc: Invoker, subscribe: Subscribe): McpApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.MCP_LIST),
    upsert: (input) => ipc.invoke(IPC_CHANNELS.MCP_UPSERT, input),
    remove: (id) => ipc.invoke(IPC_CHANNELS.MCP_REMOVE, id),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.MCP_TOGGLE, input),
    importClaude: () => ipc.invoke(IPC_CHANNELS.MCP_IMPORT_CLAUDE),
    onChanged: (callback) => subscribe(IPC_CHANNELS.MCP_CHANGED, () => callback()),
  };
}
