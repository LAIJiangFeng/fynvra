// Main 内唯一的 Telegram 服务：index.ts 创建并登记，agentHost（deps.telegram）、编排变更分发、
// 以及下一步的 telegram IPC（T5）都经这里找到它。
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import type { HostCallResult } from '@shared/types/agent';
import type { Workspace } from '@shared/types/workspace';
import type { TelegramHostDeps } from '../agentHost/agentHost';
import { fallbackWorktreesRoot } from '../orchestration/worktreesRoot';
import type { LocalInfoContext } from '../secrets';
import type { TelegramService } from './service';

let service: TelegramService | undefined;

export function setTelegramService(next: TelegramService | undefined): void {
  service = next;
}

/** T5 的 IPC handler 用；服务还没启动时 undefined */
export function getTelegramService(): TelegramService | undefined {
  return service;
}

/** 交给 createAgentHost 的 deps.telegram：服务没启动时一律失败 */
export const telegramHost: TelegramHostDeps = {
  invoke(sessionId, method, input, signal): Promise<HostCallResult> {
    return service
      ? service.invoke(sessionId, method, input, signal)
      : Promise.resolve({ ok: false, error: 'Telegram service is not running' });
  },
};

/** 编排状态变化分发给服务（notifyChanged 调用） */
export function telegramOrchestrationChanged(workspaceId: string): void {
  service?.orchestrationChanged(workspaceId);
}

/** 本机信息上下文（同 orchestration/registry 的 localInfo）：主目录、userData、各工作区与 worktrees 根，加用户名与主机名 */
export async function collectLocalInfo(input: {
  userDataPath: string;
  workspaces: readonly Workspace[];
  worktreesRoot(workspace: Workspace): Promise<string>;
}): Promise<LocalInfoContext> {
  const roots = await Promise.all(
    input.workspaces.map((workspace) => input.worktreesRoot(workspace).catch(() => undefined))
  );
  let userName: string | undefined;
  try {
    userName = userInfo().username;
  } catch {
    // 没有用户记录时只按路径与主机名替换
  }
  return {
    paths: [
      homedir(),
      tmpdir(),
      input.userDataPath,
      fallbackWorktreesRoot(input.userDataPath),
      ...input.workspaces.map((workspace) => workspace.repoPath),
      ...roots.filter((root): root is string => root !== undefined),
    ],
    ...(userName ? { userName } : {}),
    hostName: hostname(),
  };
}
