import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { PluginEntry } from '@shared/types/plugins';

export type PluginListResult = IpcResult<{ plugins: PluginEntry[] }>;
/** busy：已有安装 / 卸载在进行；canceled：取消了选择框 */
export type PluginAddResult =
  | { ok: true; plugin: PluginEntry }
  | { ok: false; code: 'canceled' | 'invalid' | 'busy' | 'failed'; error: string };
export type PluginRemoveResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'busy' | 'failed'; error: string };
export type PluginToggleResult = IpcResult<{ plugin: PluginEntry }>;

export interface PluginsApi {
  list(): Promise<PluginListResult>;
  /** Main 弹框选择插件目录或扩展文件（.ts / .js / .mjs）并登记；不传路径 */
  addLocal(): Promise<PluginAddResult>;
  /** 安装 `npm:<name>[@version]`、`git:<host>/<path>[@ref]` 或 `https://` 仓库 URL */
  install(input: { source: string }): Promise<PluginAddResult>;
  /** 本地插件只删登记；npm / git 插件先卸载再删登记 */
  remove(id: string): Promise<PluginRemoveResult>;
  toggle(input: { id: string; enabled: boolean }): Promise<PluginToggleResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createPluginsApi(ipc: Invoker, subscribe: Subscribe): PluginsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.PLUGINS_LIST),
    addLocal: () => ipc.invoke(IPC_CHANNELS.PLUGINS_ADD_LOCAL),
    install: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_INSTALL, input),
    remove: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_REMOVE, id),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_TOGGLE, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.PLUGINS_CHANGED, () => callback()),
  };
}
