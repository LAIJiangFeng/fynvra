import { basename } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import {
  parseWorkspaceId,
  type WorkspaceAddResult,
  type WorkspaceListResult,
} from '@shared/types/workspace';
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
  shell,
} from 'electron';
import type { OpenWithAppsResult, PickAppResult } from '../../preload/domains/workspaces';
import { translate } from '../i18n';
import {
  detectVsCode,
  launchApplication,
  rememberPickedApp,
  validCustomAppPath,
} from '../services/openWith';
import { readGitBranch } from '../services/sessions/branches';
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
  registerWorkspaceMenuHandlers();
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

function registerWorkspaceMenuHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACES_OPEN_WITH_APPS,
    async (_event, raw: unknown): Promise<OpenWithAppsResult> => {
      const input = asRecord(raw);
      if (
        raw !== undefined &&
        (!input ||
          Object.keys(input).some((key) => key !== 'refresh') ||
          typeof input.refresh !== 'boolean')
      ) {
        return { ok: false, error: translate('common.invalidArgs') };
      }
      try {
        const code = await detectVsCode(input?.refresh === true);
        const apps: OpenWithAppsResult = {
          ok: true,
          apps: [
            ...(code ? [{ id: 'vscode', name: 'VS Code', kind: 'vscode' as const }] : []),
            {
              id: 'explorer',
              name: translate(
                process.platform === 'darwin'
                  ? 'workspaces.finder'
                  : process.platform === 'win32'
                    ? 'workspaces.explorer'
                    : 'workspaces.fileManager'
              ),
              kind: 'explorer',
            },
            ...(getSettingsFile().read().preferences.openWithApps ?? []).map(({ id, name }) => ({
              id,
              name,
              kind: 'custom' as const,
            })),
          ],
        };
        return apps;
      } catch (error) {
        return workspaceActionFailed(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACES_OPEN_IN,
    async (_event, raw: unknown): Promise<IpcResult> => {
      const input = asRecord(raw);
      const id = parseWorkspaceId(input?.workspaceId);
      if (!id) return { ok: false, error: translate('common.invalidWorkspaceId') };
      if (
        !input ||
        typeof input.appId !== 'string' ||
        Object.keys(input).some((key) => key !== 'workspaceId' && key !== 'appId')
      ) {
        return { ok: false, error: translate('common.invalidArgs') };
      }
      try {
        const workspace = getWorkspaceService().get(id);
        if (!workspace) return { ok: false, error: translate('common.workspaceNotFound') };
        if (input.appId === 'explorer') {
          const error = await shell.openPath(workspace.repoPath);
          return error ? workspaceActionFailed(error) : { ok: true };
        }
        const application =
          input.appId === 'vscode'
            ? await detectVsCode()
            : getSettingsFile()
                .read()
                .preferences.openWithApps?.find((app) => app.id === input.appId)?.path;
        if (!application || !validCustomAppPath(application)) {
          return { ok: false, error: translate('workspaces.appUnavailable') };
        }
        await launchApplication(application, workspace.repoPath);
        return { ok: true };
      } catch (error) {
        return workspaceActionFailed(error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACES_COPY, async (_event, raw: unknown): Promise<IpcResult> => {
    const input = asRecord(raw);
    const id = parseWorkspaceId(input?.workspaceId);
    if (!id) return { ok: false, error: translate('common.invalidWorkspaceId') };
    const what = input?.what;
    if (
      !input ||
      !['path', 'name', 'branch'].includes(typeof what === 'string' ? what : '') ||
      Object.keys(input).some((key) => key !== 'workspaceId' && key !== 'what')
    ) {
      return { ok: false, error: translate('common.invalidArgs') };
    }
    try {
      const workspace = getWorkspaceService().get(id);
      if (!workspace) return { ok: false, error: translate('common.workspaceNotFound') };
      const text =
        what === 'path'
          ? workspace.repoPath
          : what === 'name'
            ? basename(workspace.repoPath) || workspace.repoPath
            : workspace.vcs === 'git'
              ? await readGitBranch(workspace.repoPath)
              : undefined;
      if (!text) return { ok: false, error: translate('workspaces.branchUnavailable') };
      clipboard.writeText(text);
      return { ok: true };
    } catch (error) {
      return workspaceActionFailed(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACES_PICK_APP, async (event): Promise<PickAppResult> => {
    try {
      const options: OpenDialogOptions = {
        title: translate('workspaces.pickApp'),
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? { filters: [{ name: 'Application', extensions: ['exe'] }] }
          : process.platform === 'darwin'
            ? { filters: [{ name: 'Application', extensions: ['app'] }] }
            : {}),
      };
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      if (result.canceled || !path)
        return { ok: false, code: 'canceled', error: translate('common.canceled') };
      if (!validCustomAppPath(path))
        return { ok: false, error: translate('workspaces.appUnavailable') };
      return { ok: true, app: rememberPickedApp(path, event.sender.id) };
    } catch (error) {
      return workspaceActionFailed(error);
    }
  });
}

function workspaceActionFailed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: translate('workspaces.actionFailed', { error: errorMessage(error) }) };
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
