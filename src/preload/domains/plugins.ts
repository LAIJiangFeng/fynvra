import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type {
  PluginEntry,
  PluginMode,
  PluginProviderMap,
  SetPluginProviderMappingInput,
} from '@shared/types/plugins';

/** providerMap：插件里的服务名 → 服务 id（全局，所有插件共用） */
export type PluginListResult = IpcResult<{
  plugins: PluginEntry[];
  providerMap: PluginProviderMap;
}>;
export type PluginSetProviderMappingResult = IpcResult<{ providerMap: PluginProviderMap }>;
/** busy：已有安装 / 卸载在进行；canceled：取消了选择框 */
export type PluginAddResult =
  | { ok: true; plugin: PluginEntry }
  | { ok: false; code: 'canceled' | 'invalid' | 'busy' | 'failed'; error: string };
export type PluginRemoveResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'busy' | 'failed'; error: string };
export type PluginToggleResult = IpcResult<{ plugin: PluginEntry }>;
/** 重新复制 / 转为副本：busy 表示已有安装、卸载或复制在进行 */
export type PluginActionResult =
  | { ok: true; plugin: PluginEntry }
  | { ok: false; code: 'invalid' | 'busy' | 'failed'; error: string };
export type PluginOpenAsWorkspaceResult = IpcResult<{ workspaceId: string }>;

export interface PluginsApi {
  list(): Promise<PluginListResult>;
  /** Main 弹框选择插件目录或扩展文件（.ts / .js / .mjs），复制（缺省）或引用后登记；不传路径 */
  addLocal(input?: { mode: PluginMode }): Promise<PluginAddResult>;
  /** 安装 `npm:<name>[@version]`、`git:<host>/<path>[@ref]` 或 `https://` 仓库 URL */
  install(input: { source: string }): Promise<PluginAddResult>;
  /** 引用的本地插件只删登记；副本连同副本目录一起删；npm / git 插件先卸载再删登记 */
  remove(id: string): Promise<PluginRemoveResult>;
  toggle(input: { id: string; enabled: boolean }): Promise<PluginToggleResult>;
  /** 用系统文件管理器打开插件所在位置 */
  reveal(id: string): Promise<IpcResult>;
  /** 用「用…打开」目标（workspaces.openWithApps 的 id）打开插件目录 */
  openIn(input: { id: string; appId: string }): Promise<IpcResult>;
  /** 把插件目录挂为普通目录工作区；已挂入时返回已有 id */
  openAsWorkspace(id: string): Promise<PluginOpenAsWorkspaceResult>;
  /** 仅副本：从来源重新复制，覆盖对副本的修改 */
  recopy(id: string): Promise<PluginActionResult>;
  /** 仅引用：复制一份并改为副本模式 */
  convertToCopy(id: string): Promise<PluginActionResult>;
  /** 插件里的服务名改用哪个模型服务（须是已存在的服务 id）；serviceId 为 null 恢复「自动（同名）」 */
  setProviderMapping(input: SetPluginProviderMappingInput): Promise<PluginSetProviderMappingResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createPluginsApi(ipc: Invoker, subscribe: Subscribe): PluginsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.PLUGINS_LIST),
    addLocal: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_ADD_LOCAL, input ?? { mode: 'copy' }),
    install: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_INSTALL, input),
    remove: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_REMOVE, id),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_TOGGLE, input),
    reveal: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_REVEAL, id),
    openIn: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_OPEN_IN, input),
    openAsWorkspace: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_OPEN_AS_WORKSPACE, id),
    recopy: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_RECOPY, id),
    convertToCopy: (id) => ipc.invoke(IPC_CHANNELS.PLUGINS_CONVERT_TO_COPY, id),
    setProviderMapping: (input) => ipc.invoke(IPC_CHANNELS.PLUGINS_SET_PROVIDER_MAPPING, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.PLUGINS_CHANGED, () => callback()),
  };
}
