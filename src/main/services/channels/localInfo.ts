// 渠道宿主出站过滤用的本机信息上下文。
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import type { Workspace } from '@shared/types/workspace';
import { fallbackWorktreesRoot } from '../orchestration/worktreesRoot';
import type { LocalInfoContext } from '../secrets';

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
