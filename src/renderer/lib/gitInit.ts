import { errorMessage } from '@shared/guards';
import { useSettingsViewStore } from '../components/settings/settingsViewStore';
import { translate } from '../i18n';
import { useWorkspacesStore } from '../stores/workspaces';
import { confirmDialog } from './appDialog';

const notify = (title: string, message: string) =>
  useWorkspacesStore.setState({ notice: { title, message } });

/** 一键把普通文件夹初始化为 git 仓库：确认 → IPC → 提示；没装 git 时转去安装并记下待初始化。仅成功时返回 true */
export async function initGitWorkspace(workspace: { id: string; name: string }): Promise<boolean> {
  const confirmed = await confirmDialog({
    message: translate('workspaces.initGitConfirm', { name: workspace.name }),
    detail: translate('workspaces.initGitDetail'),
    confirmLabel: translate('workspaces.initGit'),
  });
  if (!confirmed) return false;
  try {
    const result = await window.fynvra.workspaces.initGit({ workspaceId: workspace.id });
    if (result.ok) {
      notify(
        translate('workspaces.initGitDone'),
        translate('workspaces.initGitDoneDetail', { name: workspace.name })
      );
      return true;
    }
    if (result.code === 'git-missing') useSettingsViewStore.getState().showGitInstall(workspace.id);
    else notify(translate('workspaces.initGitFailed'), result.error);
  } catch (error) {
    notify(translate('workspaces.initGitFailed'), errorMessage(error));
  }
  return false;
}

/** git 变为可用后接续初始化发起安装的那个文件夹；只弹一次，成功后关闭设置回到原界面 */
export async function runPendingGitInit(): Promise<void> {
  const id = useSettingsViewStore.getState().pendingGitInit;
  if (!id) return;
  useSettingsViewStore.setState({ pendingGitInit: null });
  const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.id === id);
  if (workspace?.vcs !== 'none') return;
  if (await initGitWorkspace(workspace)) useSettingsViewStore.getState().close();
}
