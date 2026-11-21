import type { AppPluginView } from '@shared/types/appPlugins';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';

export type AppPluginListResult = IpcResult<{ plugins: AppPluginView[] }>;
/** busy：已有插件安装 / 删除在进行（与 PI 插件共用串行锁）；canceled：取消了选择框 */
export type AppPluginActionResult =
  | { ok: true; plugin: AppPluginView }
  | { ok: false; code: 'invalid' | 'busy' | 'failed' | 'canceled'; error: string };
export type AppPluginRemoveResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'busy' | 'failed'; error: string };

/** Fynvra 插件（后台进程 + 宿主 API）；Renderer 只传 id */
export interface AppPluginsApi {
  list(): Promise<AppPluginListResult>;
  /** 启用 / 停用立即生效 */
  toggle(input: { id: string; enabled: boolean }): Promise<AppPluginActionResult>;
  /** 停进程，删包目录、私有数据与密钥 */
  remove(input: { id: string }): Promise<AppPluginRemoveResult>;
  /** 市场更新到最新的兼容版本（仅 market 来源） */
  update(input: { id: string }): Promise<AppPluginActionResult>;
  /** 仅开发版：Main 弹框选目录后复制安装；正式版返回错误 */
  addLocalDev(): Promise<AppPluginActionResult>;
  /** 仅 local 来源：从源目录重新复制并重启 */
  recopy(input: { id: string }): Promise<AppPluginActionResult>;
  onChanged(callback: () => void): () => void;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
type Subscribe = (channel: string, listener: (...args: unknown[]) => void) => () => void;

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createAppPluginsApi(ipc: Invoker, subscribe: Subscribe): AppPluginsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_LIST),
    toggle: (input) => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_TOGGLE, input),
    remove: (input) => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_REMOVE, input),
    update: (input) => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_UPDATE, input),
    addLocalDev: () => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV),
    recopy: (input) => ipc.invoke(IPC_CHANNELS.APP_PLUGINS_RECOPY, input),
    onChanged: (callback) => subscribe(IPC_CHANNELS.APP_PLUGINS_CHANGED, () => callback()),
  };
}
