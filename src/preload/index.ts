import { IPC_CHANNELS } from '@shared/types/ipc';
import { contextBridge, ipcRenderer } from 'electron';
import { createFilesApi } from './domains/files';
import { createInstructionsApi } from './domains/instructions';
import { createMcpApi } from './domains/mcp';
import { createNotificationsApi } from './domains/notifications';
import { createOrchestrationApi } from './domains/orchestration';
import { createProvidersApi } from './domains/providers';
import { createRolesApi } from './domains/roles';
import { createSessionsApi } from './domains/sessions';
import { createSkillsApi } from './domains/skills';
import { createTerminalsApi } from './domains/terminals';
import { createUpdatesApi } from './domains/updates';
import { createUsageApi } from './domains/usage';
import type { FynvraApi, Unsubscribe } from './types';

/** 订阅 Main 推送。回调拿不到 IpcRendererEvent：它的 sender 能反向调用任意通道。 */
function subscribe(channel: string, listener: (...args: unknown[]) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: FynvraApi = {
  updates: createUpdatesApi(ipcRenderer, subscribe),
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, patch),
    pickWorktreesRoot: (input) =>
      input
        ? ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT, input)
        : ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT),
    worktreesRootInfo: (input) =>
      input
        ? ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO, input)
        : ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO),
    onChanged: (callback) => subscribe(IPC_CHANNELS.SETTINGS_CHANGED, () => callback()),
  },
  workspaces: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACES_LIST),
    add: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACES_ADD),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACES_REMOVE, id),
    onChanged: (callback) => subscribe(IPC_CHANNELS.WORKSPACES_CHANGED, () => callback()),
  },
  orchestration: createOrchestrationApi(ipcRenderer),
  files: createFilesApi(ipcRenderer),
  terminals: createTerminalsApi(ipcRenderer, subscribe),
  window: {
    platform: process.platform,
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    toggleMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    respondClose: (action) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_RESPOND_CLOSE, action),
    onCloseRequested: (callback) =>
      subscribe(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED, () => callback()),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    onMaximizedChange: (callback) =>
      subscribe(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, (maximized) => callback(maximized === true)),
  },
  sessions: createSessionsApi({
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    subscribe,
  }),
  providers: createProvidersApi(ipcRenderer, subscribe),
  roles: createRolesApi(ipcRenderer, subscribe),
  skills: createSkillsApi(ipcRenderer, subscribe),
  instructions: createInstructionsApi(ipcRenderer, subscribe),
  mcp: createMcpApi(ipcRenderer, subscribe),
  notifications: createNotificationsApi(ipcRenderer, subscribe),
  usage: createUsageApi(ipcRenderer),
};

contextBridge.exposeInMainWorld('fynvra', api);
