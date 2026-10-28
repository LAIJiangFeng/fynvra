import { IPC_CHANNELS } from '@shared/types/ipc';
import type { SettingsApi, Unsubscribe } from '../types';

export function createSettingsApi(
  ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> },
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => Unsubscribe
): SettingsApi {
  return {
    get: () => ipc.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (patch) => ipc.invoke(IPC_CHANNELS.SETTINGS_UPDATE, patch),
    testNetwork: (draft) => ipc.invoke(IPC_CHANNELS.SETTINGS_TEST_NETWORK, draft),
    cancelNetworkTest: () => ipc.invoke(IPC_CHANNELS.SETTINGS_CANCEL_NETWORK_TEST),
    availableShells: () => ipc.invoke(IPC_CHANNELS.SETTINGS_AVAILABLE_SHELLS),
    pickShell: (target) => ipc.invoke(IPC_CHANNELS.SETTINGS_PICK_SHELL, target),
    pickWorktreesRoot: (input) =>
      input
        ? ipc.invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT, input)
        : ipc.invoke(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT),
    worktreesRootInfo: (input) =>
      input
        ? ipc.invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO, input)
        : ipc.invoke(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO),
    onChanged: (callback) => subscribe(IPC_CHANNELS.SETTINGS_CHANGED, () => callback()),
  };
}
