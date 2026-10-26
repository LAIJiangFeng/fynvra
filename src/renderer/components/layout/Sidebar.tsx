import type { WorkspaceSummary } from '@shared/types/workspace';
import { Ellipsis, Folder, FolderGit2, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { Fragment } from 'react';
import { SessionList } from '@/components/chat/SessionList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/stores/workspaces';

/** 左栏：工作区列表；选中的工作区下面列出它的会话，再点一次选中的工作区折叠 / 展开会话列表。 */
export function Sidebar() {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const selectedId = useWorkspacesStore((state) => state.selectedId);
  const sessionsCollapsed = useWorkspacesStore((state) => state.sessionsCollapsed);
  const adding = useWorkspacesStore((state) => state.adding);
  const add = useWorkspacesStore((state) => state.add);
  const select = useWorkspacesStore((state) => state.select);
  const toggleSessions = useWorkspacesStore((state) => state.toggleSessions);
  const remove = useWorkspacesStore((state) => state.remove);
  const t = useT();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="font-medium text-muted-foreground text-xs">{t('workspaces.title')}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('workspaces.add')}
                disabled={adding}
              />
            }
            onClick={() => void add()}
          >
            <Plus />
          </TooltipTrigger>
          <TooltipContent>{t('workspaces.add')}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        {workspaces.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="text-muted-foreground text-sm">{t('workspaces.empty')}</p>
            <Button size="sm" variant="outline" disabled={adding} onClick={() => void add()}>
              <Plus />
              {t('workspaces.add')}
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 px-2 pb-2">
            {workspaces.map((workspace) => {
              const selected = workspace.id === selectedId;
              const expanded = selected && !sessionsCollapsed;
              return (
                <Fragment key={workspace.id}>
                  <WorkspaceItem
                    workspace={workspace}
                    selected={selected}
                    expanded={expanded}
                    // 点选中的工作区折叠 / 展开它的会话列表；点别的工作区选中它并展开
                    onSelect={() => (selected ? toggleSessions() : select(workspace.id))}
                    onRemove={() => void remove(workspace.id)}
                  />
                  {expanded && <SessionList workspaceId={workspace.id} />}
                </Fragment>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

function WorkspaceItem({
  workspace,
  selected,
  expanded,
  onSelect,
  onRemove,
}: {
  workspace: WorkspaceSummary;
  selected: boolean;
  /** 选中且会话列表展开着 */
  expanded: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const FolderIcon = expanded ? FolderOpen : workspace.vcs === 'none' ? Folder : FolderGit2;
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        // 选中的工作区控制它下面的会话列表
        aria-expanded={selected ? expanded : undefined}
        onClick={onSelect}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
          selected && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
      >
        <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 pr-6">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{workspace.name}</span>
            {workspace.vcs === 'none' && (
              <Badge
                variant="outline"
                title={t('common.noWorktrees')}
                className="px-1 py-0 font-normal text-[10px] leading-4"
              >
                {t('common.noGit')}
              </Badge>
            )}
          </span>
          <span
            className="block truncate text-muted-foreground text-xs"
            title={workspace.displayPath}
          >
            {workspace.displayPath}
          </span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('workspaces.moreActions', { name: workspace.name })}
              className="absolute top-1.5 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
            />
          }
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2 />
            {t('workspaces.removeFromList')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
