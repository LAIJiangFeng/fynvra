import type { UpdateState } from '@shared/types/updates';

export function updateUnavailableReason(
  isPackaged: boolean,
  platform: string,
  arch: string,
  macUpdateMode?: unknown
): UpdateState['reason'] {
  if (!isPackaged) return 'development';
  if (platform === 'win32' && arch === 'x64') return undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64'))
    // manual 包由自替换更新器处理；未知或损坏的标记一律只允许手动安装。
    return macUpdateMode === 'signed' || macUpdateMode === 'manual' ? undefined : 'manual-install';
  return 'unsupported';
}
