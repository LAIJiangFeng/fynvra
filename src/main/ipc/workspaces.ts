import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  parseWorkspaceId,
  type WorkspaceAddResult,
  type WorkspaceListResult,
} from '@shared/types/workspace';
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { createWorkspaceService, type WorkspaceService } from '../services/workspaces';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getSettingsFile } from './settings';

let service: WorkspaceService | null = null;

/** Main 内共享的工作区注册表（后续 worktree / 会话按 id 取 repoPath 也走这里）。 */
export function getWorkspaceService(): WorkspaceService {
  service ??= createWorkspaceService({ settings: getSettingsFile() });
  return service;
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACES_LIST, (): WorkspaceListResult => {
    try {
      return { ok: true, workspaces: getWorkspaceService().list() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // 不接收 Renderer 传来的路径：目录由 Main 弹窗选择，校验通过后才写入 settings
  ipcMain.handle(IPC_CHANNELS.WORKSPACES_ADD, async (event): Promise<WorkspaceAddResult> => {
    try {
      const dir = await pickDirectory(event.sender);
      if (!dir) return { ok: false, code: 'canceled', error: '已取消选择' };
      const result = await getWorkspaceService().addDirectory(dir);
      if (result.ok && result.created) sendToAllWindows(IPC_CHANNELS.WORKSPACES_CHANGED);
      return result;
    } catch (error) {
      return { ok: false, code: 'failed', error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACES_REMOVE, (_event, rawId: unknown): IpcResult => {
    const id = parseWorkspaceId(rawId);
    if (!id) return { ok: false, error: '无效的工作区 id' };
    try {
      if (!getWorkspaceService().remove(id)) return { ok: false, error: '工作区不存在' };
      sendToAllWindows(IPC_CHANNELS.WORKSPACES_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}

async function pickDirectory(sender: Electron.WebContents): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '挂入 git 仓库',
    buttonLabel: '挂入',
    properties: ['openDirectory'],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
