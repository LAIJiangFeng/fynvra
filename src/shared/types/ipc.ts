/**
 * Renderer ⇄ Main 的全部 IPC 通道，命名 `domain:action`。
 * 新增通道必须三处同步：这里的常量、`src/main/ipc/<domain>.ts` 的 handler、`src/preload` 的 typed 出口。
 */
export const IPC_CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  /** Main → Renderer：偏好已变更，各窗口重读 */
  SETTINGS_CHANGED: 'settings:changed',

  WORKSPACES_LIST: 'workspaces:list',
  /** Main 弹目录选择框并校验；Renderer 不传路径 */
  WORKSPACES_ADD: 'workspaces:add',
  WORKSPACES_REMOVE: 'workspaces:remove',
  /** Main → Renderer：工作区列表已变更 */
  WORKSPACES_CHANGED: 'workspaces:changed',

  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** Main → Renderer：窗口最大化状态变化 */
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** 跨 IPC 边界的统一返回形状：handler 不抛异常，失败时带可展示的错误信息。 */
export type IpcResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
