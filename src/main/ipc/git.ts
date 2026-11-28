import { asRecord, errorMessage } from '@shared/guards';
import type { GitInstallResult, GitStatusResult } from '@shared/types/git';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, ipcMain, net } from 'electron';
import { translate } from '../i18n';
import { createGitSetup, defaultExec, type GitSetup } from '../services/gitSetup';
import { getWorkspaceService } from './workspaces';

let setup: GitSetup | null = null;

/** Main 内共享的 git 环境服务；下载走 net.fetch（应用与系统代理） */
export function getGitSetup(): GitSetup {
  setup ??= createGitSetup({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    userDataPath: app.getPath('userData'),
    fetch: (url, init) => net.fetch(url, init),
    exec: defaultExec,
  });
  return setup;
}

/** Renderer 不能传任何 URL 或路径：status / install 无参，set-identity 只收 { name, email } */
export function registerGitHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GIT_STATUS,
    async (_event, ...args: unknown[]): Promise<GitStatusResult> => {
      if (args.length > 0) return { ok: false, error: translate('common.invalidArgs') };
      try {
        return { ok: true, status: await getGitSetup().status() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_INSTALL,
    async (_event, ...args: unknown[]): Promise<GitInstallResult> => {
      if (args.length > 0) return { ok: false, error: translate('common.invalidArgs') };
      try {
        const result = await getGitSetup().install();
        if (result.status?.available) {
          // 根目录已有 .git 的普通目录工作区转成 git
          getWorkspaceService()
            .refreshVcs(undefined, { onlyPlain: true })
            .catch((error: unknown) => console.warn('[git] vcs re-detection failed:', error));
        }
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_SET_IDENTITY,
    async (_event, input: unknown): Promise<GitStatusResult> => {
      const record = asRecord(input);
      if (!record || typeof record.name !== 'string' || typeof record.email !== 'string') {
        return { ok: false, error: translate('common.invalidArgs') };
      }
      try {
        const status = await getGitSetup().setIdentity({ name: record.name, email: record.email });
        return { ok: true, status };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
