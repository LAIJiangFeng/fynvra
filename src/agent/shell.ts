import { win32 } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Role } from '@fynvra/core';
import type { CompactionStrategy } from '@shared/types/settings';

/**
 * 会话的 pi 设置：与 agent-runtime 的默认相同（内存设置，不读 ~/.pi 与项目 .pi；关掉安装遥测），
 * 另外按 spawn-session 的 shellPath 指定 bash 工具的 shell（pi 以 -c 执行）。
 * 上下文压缩只在用户选择关闭时覆盖 `compaction.enabled`；原生模式保留 SDK 的其余默认值。
 * Main 默认探测 Git Bash，也可指定 PowerShell；不自动退回 WSL。
 */
export function createSessionSettings(
  shellPath: string | undefined,
  compactionStrategy?: CompactionStrategy
): SettingsManager {
  return SettingsManager.inMemory({
    enableInstallTelemetry: false,
    ...(shellPath ? { shellPath } : {}),
    ...(compactionStrategy === 'off' ? { compaction: { enabled: false } } : {}),
  });
}

/** Feed the shell instruction through createRoleSession's existing role prompt append path. */
export function roleWithShellPrompt(role: Role, shellPath: string | undefined): Role {
  if (!shellPath) return role;
  const name = win32
    .basename(shellPath)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'bash') return role;
  const shell =
    name === 'pwsh'
      ? 'PowerShell 7'
      : name === 'powershell'
        ? 'Windows PowerShell 5.1'
        : JSON.stringify(shellPath);
  const syntax =
    name === 'pwsh' || name === 'powershell' ? 'PowerShell syntax' : "that shell's native syntax";
  const line = `On this machine the bash tool runs commands with ${shell} via -c; write ${syntax}.`;
  return { ...role, systemPrompt: [role.systemPrompt, line].filter(Boolean).join('\n\n') };
}
