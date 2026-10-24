import { FolderGit2, GitBranch, MessagesSquare, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { selectSelectedWorkspace, useWorkspacesStore } from '@/stores/workspaces';

/** 中栏：未选工作区时给出引导；选中后展示工作区信息（会话区在 Wave 2 接入）。 */
export function MainArea() {
  const workspace = useWorkspacesStore(selectSelectedWorkspace);
  const hasWorkspaces = useWorkspacesStore((state) => state.workspaces.length > 0);
  const adding = useWorkspacesStore((state) => state.adding);
  const add = useWorkspacesStore((state) => state.add);

  if (!workspace) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <FolderGit2 className="size-10 text-muted-foreground/60" />
        <p className="text-muted-foreground">选择一个工作区开始</p>
        {!hasWorkspaces && (
          <Button disabled={adding} onClick={() => void add()}>
            <Plus />
            挂入仓库
          </Button>
        )}
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="truncate font-semibold text-lg">{workspace.name}</h1>
        <p className="flex min-w-0 items-center gap-3 text-muted-foreground text-sm">
          <span className="truncate" title={workspace.displayPath}>
            {workspace.displayPath}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <GitBranch className="size-3.5" />
            {workspace.defaultBranch}
          </span>
        </p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <MessagesSquare className="size-10 text-muted-foreground/60" />
        <p className="text-muted-foreground text-sm">还没有会话</p>
      </div>
    </main>
  );
}
