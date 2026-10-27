import { errorMessage } from '@shared/guards';
import type { OpenWithApp } from '@shared/types/settings';
import type { WorkspaceSummary } from '@shared/types/workspace';
import {
  AppWindow,
  ChevronRight,
  Code,
  Copy,
  Ellipsis,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { SessionList } from '@/components/chat/SessionList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/stores/workspaces';
import { CustomAppDialog } from './CustomAppDialog';

/** 左栏：工作区独立展开会话列表；选中工作区仍只有一个。 */
export function Sidebar() {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const selectedId = useWorkspacesStore((state) => state.selectedId);
  const expandedWorkspaces = useWorkspacesStore((state) => state.expandedWorkspaces);
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
              const expanded = expandedWorkspaces[workspace.id] === true;
              return (
                <Fragment key={workspace.id}>
                  <WorkspaceItem
                    workspace={workspace}
                    selected={selected}
                    expanded={expanded}
                    onSelect={() => select(workspace.id)}
                    onToggle={() => toggleSessions(workspace.id)}
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
  onToggle,
  onRemove,
}: {
  workspace: WorkspaceSummary;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const triggerId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [customDialog, setCustomDialog] = useState<{ app: OpenWithApp | null } | null>(null);
  const targets = useWorkspacesStore((state) => state.openWithTargets);
  const loadApps = useWorkspacesStore((state) => state.loadOpenWithApps);
  const openIn = useWorkspacesStore((state) => state.openIn);
  const copy = useWorkspacesStore((state) => state.copy);
  const changeMenuOpen = (open: boolean) => {
    setMenuOpen(open);
    if (open) void loadApps();
  };
  const pickApp = async () => {
    try {
      const result = await window.fynvra.workspaces.pickApp();
      if (result.ok) setCustomDialog({ app: result.app });
      else if (result.code !== 'canceled')
        useWorkspacesStore.setState({
          notice: { title: t('workspaces.actionFailed'), message: result.error },
        });
    } catch (error) {
      useWorkspacesStore.setState({
        notice: { title: t('workspaces.actionFailed'), message: errorMessage(error) },
      });
    }
  };
  const FolderIcon = expanded ? FolderOpen : workspace.vcs === 'none' ? Folder : FolderGit2;
  return (
    <li className="group relative">
      <button
        type="button"
        aria-label={t(expanded ? 'workspaces.collapseSessions' : 'workspaces.expandSessions', {
          name: workspace.name,
        })}
        aria-expanded={expanded}
        onClick={onToggle}
        className="absolute top-1.5 left-0 z-10 flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
        />
      </button>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        onContextMenu={(event) => {
          event.preventDefault();
          changeMenuOpen(true);
        }}
        className={cn(
          'flex w-full items-start gap-2 rounded-md py-1.5 pr-2 pl-6 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
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

      <DropdownMenu open={menuOpen} onOpenChange={changeMenuOpen} triggerId={triggerId}>
        <DropdownMenuTrigger
          id={triggerId}
          onContextMenu={(event) => {
            event.preventDefault();
            changeMenuOpen(true);
          }}
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppWindow />
              {t('workspaces.openIn')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-72">
              {targets.length === 0 && (
                <DropdownMenuItem disabled>{t('common.loading')}</DropdownMenuItem>
              )}
              {targets.map((target) => {
                const Icon =
                  target.kind === 'vscode' ? Code : target.kind === 'explorer' ? Folder : AppWindow;
                return (
                  <DropdownMenuItem
                    key={target.id}
                    onClick={() => void openIn(workspace.id, target.id)}
                  >
                    <Icon />
                    <span className="truncate">{target.name}</span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void pickApp()}>
                <Plus />
                {t('workspaces.customApp')}
              </DropdownMenuItem>
              {targets.some((target) => target.kind === 'custom') && (
                <DropdownMenuItem onClick={() => setCustomDialog({ app: null })}>
                  <Settings2 />
                  {t('workspaces.manageApps')}
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => void copy(workspace.id, 'path')}>
            <Copy />
            {t('workspaces.copyPath')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copy(workspace.id, 'name')}>
            <Copy />
            {t('workspaces.copyName')}
          </DropdownMenuItem>
          {workspace.vcs === 'git' && (
            <DropdownMenuItem onClick={() => void copy(workspace.id, 'branch')}>
              <GitBranch />
              {t('workspaces.copyBranch')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2 />
            {t('workspaces.removeFromList')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {customDialog && (
        <CustomAppDialog initialApp={customDialog.app} onClose={() => setCustomDialog(null)} />
      )}
    </li>
  );
}
