import { SettingsManager } from '@earendil-works/pi-coding-agent';

/**
 * 会话的 pi 设置：与 agent-runtime 的默认相同（内存设置，不读 ~/.pi 与项目 .pi；关掉安装遥测），
 * 另外按 spawn-session 的 shellPath 指定 bash 工具的 shell。Windows 上 Main 给的是 Git Bash：
 * pi 自己找时可能取到 PATH 上的 WSL bash.exe，WSL 的 git 读不懂 worktree 的 `gitdir:`，提交会失败。
 */
export function createSessionSettings(shellPath: string | undefined): SettingsManager {
  return SettingsManager.inMemory({
    enableInstallTelemetry: false,
    ...(shellPath ? { shellPath } : {}),
  });
}
