import { win32 } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Role } from '@fynvra/core';
import type { CompactionStrategy } from '@shared/types/settings';

/**
 * 会话的 pi 设置：与 agent-runtime 的默认相同（内存设置，不读 ~/.pi 与项目 .pi；关掉安装遥测），
 * 另外按 spawn-session 的 shellPath 指定 bash 工具的 shell（pi 以 -c 执行）。
 * 仅显式 native 启用 SDK 原生自动压缩；Magic Context 通过自己的 context hooks 整理历史，
 * 插件未就绪或失败时也不启用原生摘要。Main 和 worker 的缺省策略均为 Magic。
 * Main 默认探测 Git Bash，也可指定 PowerShell；不自动退回 WSL。
 * 设了自动压缩阈值 T 时，reserve 按当前模型窗口取 max(默认 reserve, 窗口 − T)，
 * 即有效阈值 = min(T, 窗口 − 默认 reserve)；每次解析都重算，换模型后自动跟随新窗口。
 */
export function createSessionSettings(
  shellPath: string | undefined,
  compactionStrategy?: CompactionStrategy,
  compactionThresholdTokens?: number
): SettingsManager {
  const settings = SettingsManager.inMemory({
    enableInstallTelemetry: false,
    ...(shellPath ? { shellPath } : {}),
    compaction: { enabled: compactionStrategy === 'native' },
  });
  if (compactionThresholdTokens === undefined) return settings;
  const reserveOf = settings.getCompactionReserveTokens.bind(settings);
  // pi 的 getCompactionSettings(model) 经由这个方法取 reserve；调用方传的是完整 Model（含 contextWindow）
  settings.getCompactionReserveTokens = (model) => {
    const reserve = reserveOf(model);
    const window = (model as { contextWindow?: unknown } | undefined)?.contextWindow;
    return typeof window === 'number' && Number.isFinite(window) && window > 0
      ? Math.max(reserve, Math.floor(window) - compactionThresholdTokens)
      : reserve;
  };
  return settings;
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
