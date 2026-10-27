import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import type { OpenWithApp } from '@shared/types/settings';
import type { WorkspaceAddResult, WorkspaceListResult } from '@shared/types/workspace';
import type { Unsubscribe } from '../types';

export interface OpenWithTarget {
  id: string;
  name: string;
  kind: 'vscode' | 'explorer' | 'custom';
}

export type WorkspaceCopyKind = 'path' | 'name' | 'branch';
export type OpenWithAppsResult = IpcResult<{ apps: OpenWithTarget[] }>;
export type PickAppResult =
  | { ok: true; app: OpenWithApp }
  | { ok: false; code?: 'canceled'; error: string };

export interface WorkspacesApi {
  list(): Promise<WorkspaceListResult>;
  /** Main chooses the directory; Renderer never supplies a workspace path. */
  add(): Promise<WorkspaceAddResult>;
  remove(id: string): Promise<IpcResult>;
  openWithApps(input?: { refresh: boolean }): Promise<OpenWithAppsResult>;
  openIn(input: { workspaceId: string; appId: string }): Promise<IpcResult>;
  copy(input: { workspaceId: string; what: WorkspaceCopyKind }): Promise<IpcResult>;
  pickApp(): Promise<PickAppResult>;
  onChanged(callback: () => void): Unsubscribe;
}

export function createWorkspacesApi(
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> },
  subscribe: (channel: string, listener: () => void) => Unsubscribe
): WorkspacesApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.WORKSPACES_LIST) as Promise<WorkspaceListResult>,
    add: () => ipc.invoke(IPC_CHANNELS.WORKSPACES_ADD) as Promise<WorkspaceAddResult>,
    remove: (id) => ipc.invoke(IPC_CHANNELS.WORKSPACES_REMOVE, id) as Promise<IpcResult>,
    openWithApps: (input) =>
      (input
        ? ipc.invoke(IPC_CHANNELS.WORKSPACES_OPEN_WITH_APPS, { refresh: input.refresh })
        : ipc.invoke(IPC_CHANNELS.WORKSPACES_OPEN_WITH_APPS)) as Promise<OpenWithAppsResult>,
    openIn: ({ workspaceId, appId }) =>
      ipc.invoke(IPC_CHANNELS.WORKSPACES_OPEN_IN, { workspaceId, appId }) as Promise<IpcResult>,
    copy: ({ workspaceId, what }) =>
      ipc.invoke(IPC_CHANNELS.WORKSPACES_COPY, { workspaceId, what }) as Promise<IpcResult>,
    pickApp: () => ipc.invoke(IPC_CHANNELS.WORKSPACES_PICK_APP) as Promise<PickAppResult>,
    onChanged: (callback) => subscribe(IPC_CHANNELS.WORKSPACES_CHANGED, callback),
  };
}
