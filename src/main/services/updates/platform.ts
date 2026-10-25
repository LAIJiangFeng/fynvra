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
    return macUpdateMode === 'signed' ? undefined : 'manual-install';
  return 'unsupported';
}
