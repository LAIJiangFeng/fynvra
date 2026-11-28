import type { GitIdentityInput, GitInstallResult, GitStatusResult } from '@shared/types/git';
import { IPC_CHANNELS } from '@shared/types/ipc';

export interface GitApi {
  status(): Promise<GitStatusResult>;
  /** Windows：下载并安装 Fynvra 自带的便携 MinGit；macOS：调起系统安装窗口 */
  install(): Promise<GitInstallResult>;
  setIdentity(input: GitIdentityInput): Promise<GitStatusResult>;
}

export function createGitApi(ipc: {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
}): GitApi {
  return {
    status: () => ipc.invoke(IPC_CHANNELS.GIT_STATUS),
    install: () => ipc.invoke(IPC_CHANNELS.GIT_INSTALL),
    setIdentity: ({ name, email }) => ipc.invoke(IPC_CHANNELS.GIT_SET_IDENTITY, { name, email }),
  };
}
