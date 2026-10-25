import type { IpcResult } from './ipc';

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

/** 只暴露状态，不把更新地址、安装路径或发布凭证交给 Renderer。 */
export interface UpdateState {
  seq: number;
  status: UpdateStatus;
  currentVersion: string;
  version?: string;
  percent?: number;
  checkedAt?: number;
  reason?: 'development' | 'unsupported' | 'manual-install';
  error?: string;
}

export type UpdateResult = IpcResult<{ state: UpdateState }>;
