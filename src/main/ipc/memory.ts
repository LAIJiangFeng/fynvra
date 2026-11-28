import { join } from 'node:path';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  parseMemoryClearInput,
  parseMemoryCreateInput,
  parseMemoryListInput,
  parseMemoryRemoveInput,
  parseMemoryUpdateInput,
} from '@shared/types/memory';
import { app, ipcMain } from 'electron';
import { translate } from '../i18n';
import { createMemoryService, type MemoryService } from '../services/memory';
import { collectAppSecrets } from '../services/secrets';
import { readHistory, sessionFilePath } from '../services/sessions/history';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getSettingsFile } from './settings';
import { getWorkspaceService } from './workspaces';

/** quote 核对与提炼看的最近用户消息条数 */
const RECENT_USER_MESSAGES = 20;

let memoryService: MemoryService | null = null;

/** pi 会话 jsonl 的投影；记忆服务的 quote 核对与提炼共用 */
export function readSessionMessages(sessionId: string) {
  const agentDir = join(app.getPath('userData'), 'agent');
  return readHistory(sessionFilePath(agentDir, sessionId), sessionId);
}

/** 工作区 id → 路径与 vcs；没有时 undefined（记忆服务与提炼共用） */
export function memoryWorkspace(workspaceId: string) {
  const workspace = getWorkspaceService().get(workspaceId);
  return workspace ? { path: workspace.repoPath, vcs: workspace.vcs } : undefined;
}

/** Main 唯一的项目记忆服务（库在 `<userData>/memory/memory.db`）；userData 路径在启动早期才确定，所以延迟创建 */
export function getMemoryService(): MemoryService {
  memoryService ??= createMemoryService({
    dbPath: join(app.getPath('userData'), 'memory', 'memory.db'),
    preferences: () => getSettingsFile().read().preferences,
    workspace: memoryWorkspace,
    recentUserMessages: async (sessionId) => {
      try {
        return (await readSessionMessages(sessionId))
          .filter((message) => message.role === 'user')
          .slice(-RECENT_USER_MESSAGES)
          .map((message) => message.text);
      } catch {
        return [];
      }
    },
    knownSecrets: collectAppSecrets,
    onChanged: (workspaceIds) => sendToAllWindows(IPC_CHANNELS.MEMORY_CHANGED, { workspaceIds }),
  });
  return memoryService;
}

const invalid = (): IpcResult<never> => ({ ok: false, error: translate('common.invalidArgs') });

/** `memory:*`：入参一律按 unknown 收窄（拒绝多余键），返回给 Renderer 的只有 MemoryView */
export function registerMemoryHandlers(service: () => MemoryService = getMemoryService): void {
  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, (_event, raw: unknown) => {
    const input = parseMemoryListInput(raw);
    return input ? service().list(input.workspaceId) : invalid();
  });
  ipcMain.handle(IPC_CHANNELS.MEMORY_CREATE, (_event, raw: unknown) => {
    const input = parseMemoryCreateInput(raw);
    return input ? service().create(input) : invalid();
  });
  ipcMain.handle(IPC_CHANNELS.MEMORY_UPDATE, (_event, raw: unknown) => {
    const input = parseMemoryUpdateInput(raw);
    return input ? service().update(input) : invalid();
  });
  ipcMain.handle(IPC_CHANNELS.MEMORY_REMOVE, (_event, raw: unknown) => {
    const input = parseMemoryRemoveInput(raw);
    return input ? service().remove(input) : invalid();
  });
  ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR, (_event, raw: unknown) => {
    const input = parseMemoryClearInput(raw);
    return input ? service().clear(input.workspaceId) : invalid();
  });
}
