import { FolderGit2, GitBranch, Plus } from 'lucide-react';
import { ChatPlaceholder, ChatView } from '@/components/chat/ChatView';
import { FileWorkspace } from '@/components/files/FileWorkspace';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { selectActiveSessionId, useSessionsStore } from '@/stores/sessions';
import { selectSelectedWorkspace, useWorkspacesStore } from '@/stores/workspaces';

/** 中栏：未选工作区时给出引导；选中会话时是聊天视图，否则展示工作区信息。 */
export function MainArea() {
  const workspace = useWorkspacesStore(selectSelectedWorkspace);
  const hasWorkspaces = useWorkspacesStore((state) => state.workspaces.length > 0);
  const adding = useWorkspacesStore((state) => state.adding);
  const add = useWorkspacesStore((state) => state.add);
  const activeSessionId = useSessionsStore(selectActiveSessionId);
  const t = useT();

  if (!workspace) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <FolderGit2 className="size-10 text-muted-foreground/60" />
        <p className="text-muted-foreground">{t('workspaces.pickToStart')}</p>
        {!hasWorkspaces && (
          <Button disabled={adding} onClick={() => void add()}>
            <Plus />
            {t('workspaces.add')}
          </Button>
        )}
      </main>
    );
  }

  return (
    <FileWorkspace key={workspace.id} workspaceId={workspace.id}>
      {activeSessionId ? (
        <ChatView key={activeSessionId} sessionId={activeSessionId} />
      ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-b px-6 py-4">
            <h1 className="truncate font-semibold text-lg">{workspace.name}</h1>
            <p className="flex min-w-0 items-center gap-3 text-muted-foreground text-sm">
              <span className="truncate" title={workspace.displayPath}>
                {workspace.displayPath}
              </span>
              {workspace.defaultBranch && (
                <span className="flex shrink-0 items-center gap-1">
                  <GitBranch className="size-3.5" />
                  {workspace.defaultBranch}
                </span>
              )}
            </p>
          </header>
          <ChatPlaceholder workspaceId={workspace.id} />
        </main>
      )}
    </FileWorkspace>
  );
}
