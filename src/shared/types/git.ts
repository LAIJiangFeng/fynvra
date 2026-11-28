import type { IpcResult } from './ipc';

/** 实际用到的 git 来源：系统安装、Fynvra 自带的便携 MinGit、或不可用 */
export type GitSource = 'system' | 'bundled' | 'none';

export interface GitStatus {
  available: boolean;
  version?: string;
  source: GitSource;
  /** 全局 user.name / user.email，未设置为空串 */
  userName: string;
  userEmail: string;
}

export interface GitIdentityInput {
  name: string;
  email: string;
}

export type GitStatusResult = IpcResult<{ status: GitStatus }>;
/** Windows 安装完成后带最新状态；macOS 只表示系统安装窗口已调起 */
export type GitInstallResult = IpcResult<{ status?: GitStatus; started?: boolean }>;
