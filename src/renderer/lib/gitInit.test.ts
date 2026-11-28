/// <reference types="vite/client" />
import type { WorkspaceSummary } from '@shared/types/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('./appDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./appDialog')>()),
  confirmDialog: mocks.confirm,
}));

const workspace = (id: string, vcs: WorkspaceSummary['vcs']): WorkspaceSummary => ({
  id,
  name: id,
  displayPath: `/${id}`,
  vcs,
});

async function setup(initResult: unknown = { ok: true }) {
  mocks.confirm.mockReset().mockResolvedValue(true);
  const initGit = vi.fn(async () => initResult);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    fynvra: {
      workspaces: { initGit, onChanged: vi.fn(() => () => {}) },
      notifications: { onFocusSession: vi.fn(), setViewing: vi.fn() },
    },
  });
  const { useSettingsViewStore: view } = await import('../components/settings/settingsViewStore');
  const { useWorkspacesStore } = await import('../stores/workspaces');
  const gitInit = await import('./gitInit');
  useWorkspacesStore.setState({
    workspaces: [workspace('plain', 'none'), workspace('repo', 'git')],
  });
  return { view, initGit, confirm: mocks.confirm, ...gitInit };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('装好 git 后接续初始化', () => {
  it('showGitInstall 打开 git 分组并记下 pending，close 后清空', async () => {
    const { view } = await setup();
    view.getState().showGitInstall('plain');
    expect(view.getState()).toMatchObject({ open: true, section: 'git', pendingGitInit: 'plain' });
    view.getState().close();
    expect(view.getState().pendingGitInit).toBeNull();
  });

  it('确认后初始化、关闭设置，且只弹一次', async () => {
    const { view, initGit, runPendingGitInit } = await setup();
    view.getState().showGitInstall('plain');
    await runPendingGitInit();
    expect(initGit).toHaveBeenCalledWith({ workspaceId: 'plain' });
    expect(view.getState()).toMatchObject({ open: false, pendingGitInit: null });
    await runPendingGitInit();
    expect(initGit).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'repo'])('工作区 %s 不存在或已是 git：不弹框不调 IPC', async (id) => {
    const { view, initGit, confirm, runPendingGitInit } = await setup();
    view.getState().showGitInstall(id);
    await runPendingGitInit();
    expect(confirm).not.toHaveBeenCalled();
    expect(initGit).not.toHaveBeenCalled();
    expect(view.getState().pendingGitInit).toBeNull();
  });

  it('确认框取消：不调 IPC，设置保持打开，pending 清空', async () => {
    const { view, initGit, confirm, runPendingGitInit } = await setup();
    confirm.mockResolvedValue(false);
    view.getState().showGitInstall('plain');
    await runPendingGitInit();
    expect(initGit).not.toHaveBeenCalled();
    expect(view.getState()).toMatchObject({ open: true, pendingGitInit: null });
  });

  it('initGitWorkspace 遇到 git-missing 转去安装并记下 pending', async () => {
    const { view, initGitWorkspace } = await setup({
      ok: false,
      code: 'git-missing',
      error: 'no git',
    });
    expect(await initGitWorkspace({ id: 'plain', name: 'plain' })).toBe(false);
    expect(view.getState()).toMatchObject({ open: true, section: 'git', pendingGitInit: 'plain' });
  });
});
