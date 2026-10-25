export function updateUnavailableReason(
  isPackaged: boolean,
  platform: string,
  arch: string
): 'development' | 'unsupported' | undefined {
  if (!isPackaged) return 'development';
  if (platform === 'win32' && arch === 'x64') return undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return undefined;
  return 'unsupported';
}
