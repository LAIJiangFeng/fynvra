import { errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  parseWorkspaceId,
  type WorkspaceAddResult,
  type WorkspaceListResult,
} from '@shared/types/workspace';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import { translate } from '../i18n';
import { createWorkspaceService, type WorkspaceService } from '../services/workspaces';
import { sendToAllWindows } from '../windows/createAppWindow';
import { getSettingsFile } from './settings';

let service: WorkspaceService | null = null;

/** Main 内共享的工作区注册表（后续 worktree / 会话按 id 取 repoPath 也走这里）。 */
export function getWorkspaceService(): WorkspaceService {
  service ??= createWorkspaceService({ settings: getSettingsFile() });
  return service;
}

const canceled = (): WorkspaceAddResult => ({
  ok: false,
  code: 'canceled',
  error: translate('common.canceled'),
});

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACES_LIST, (): WorkspaceListResult => {
    try {
      return { ok: true, workspaces: getWorkspaceService().list() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // 不接收 Renderer 传来的路径：目录由 Main 弹窗选择，检查之后才写入 settings
  ipcMain.handle(IPC_CHANNELS.WORKSPACES_ADD, async (event): Promise<WorkspaceAddResult> => {
    try {
      const dir = await pickDirectory(event.sender);
      if (!dir) return canceled();
      const result = await addPicked(event.sender, dir);
      if (result.ok && result.created) sendToAllWindows(IPC_CHANNELS.WORKSPACES_CHANGED);
      return result;
    } catch (error) {
      return { ok: false, code: 'failed', error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACES_REMOVE, (_event, rawId: unknown): IpcResult => {
    const id = parseWorkspaceId(rawId);
    if (!id) return { ok: false, error: translate('common.invalidWorkspaceId') };
    try {
      if (!getWorkspaceService().remove(id))
        return { ok: false, error: translate('common.workspaceNotFound') };
      sendToAllWindows(IPC_CHANNELS.WORKSPACES_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}

/** 仓库子目录先问用户：改挂仓库根目录（用 worktree），还是把子目录按普通目录挂入。 */
async function addPicked(sender: Electron.WebContents, dir: string): Promise<WorkspaceAddResult> {
  const workspaces = getWorkspaceService();
  const result = await workspaces.addDirectory(dir);
  if (result.ok || result.code !== 'not-repo-root') return result;
  const choice = await askNestedDirectory(sender, result.repoRoot);
  if (choice === 'cancel') return canceled();
  const retried =
    choice === 'root'
      ? await workspaces.addDirectory(result.repoRoot)
      : await workspaces.addDirectory(dir, { plain: true });
  // 仓库根目录本身不会再是子目录；万一（如目录在这期间被挪走）只报错，不再追问
  return retried.ok || retried.code !== 'not-repo-root'
    ? retried
    : { ok: false, code: 'failed', error: retried.error };
}

async function pickDirectory(sender: Electron.WebContents): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: translate('workspaces.add'),
    buttonLabel: translate('workspaces.addButton'),
    properties: ['openDirectory'],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function askNestedDirectory(
  sender: Electron.WebContents,
  repoRoot: string
): Promise<'root' | 'plain' | 'cancel'> {
  const options: MessageBoxOptions = {
    type: 'question',
    title: translate('workspaces.add'),
    message: translate('workspaces.insideRepo'),
    detail: translate('workspaces.insideRepoDetail', { root: repoRoot }),
    buttons: [
      translate('workspaces.useRepoRoot'),
      translate('workspaces.useSubfolder'),
      translate('common.cancel'),
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const win = BrowserWindow.fromWebContents(sender);
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 0 ? 'root' : response === 1 ? 'plain' : 'cancel';
}
