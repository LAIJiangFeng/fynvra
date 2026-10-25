import type { WorkspaceFileEntry } from '@shared/types/files';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type FilesStore, ROOT_DIRECTORY_ID } from '@/stores/files';

/** 右栏只浏览目录；文件内容由中央工作区承载。 */
export function FilesView({ store, workspaceName }: { store: FilesStore; workspaceName: string }) {
  const t = useT();

  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section
        aria-label={t('files.explorer')}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 font-medium text-xs">
          <FolderOpen className="size-3.5 text-muted-foreground" />
          <span className="truncate" title={workspaceName}>
            {workspaceName}
          </span>
          <span className="ml-auto shrink-0 font-normal text-muted-foreground">
            {t('files.explorer')}
          </span>
        </div>
        <nav aria-label={t('files.explorer')} className="min-h-0 flex-1 overflow-auto pb-2">
          <DirectoryEntries store={store} depth={0} />
        </nav>
      </section>
    </div>
  );
}

function DirectoryEntries({
  store,
  directoryId,
  depth,
}: {
  store: FilesStore;
  directoryId?: string;
  depth: number;
}) {
  const t = useT();
  const directory = store((state) => state.directories[directoryId ?? ROOT_DIRECTORY_ID]);
  if (!directory || (directory.loading && directory.entries.length === 0))
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-4 py-2 text-muted-foreground text-xs"
      >
        <Loader2 className="size-3 animate-spin" />
        {t('common.loading')}
      </div>
    );
  if (directory.error)
    return (
      <div role="alert" className="space-y-1 px-4 py-2 text-muted-foreground text-xs">
        <p>{t(`files.errors.${directory.error}`)}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void store.getState().loadDirectory(directoryId, true)}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  return (
    <ul className="min-w-fit">
      {directory.entries.map((entry) => (
        <FileRow key={entry.id} entry={entry} store={store} depth={depth} />
      ))}
      {directory.entries.length === 0 && (
        <li className="px-4 py-2 text-muted-foreground text-xs">{t('files.emptyDirectory')}</li>
      )}
      {directory.truncated && (
        <li className="px-4 py-2 text-amber-600 text-xs dark:text-amber-400">
          {t('files.truncated')}
        </li>
      )}
    </ul>
  );
}

function FileRow({
  entry,
  store,
  depth,
}: {
  entry: WorkspaceFileEntry;
  store: FilesStore;
  depth: number;
}) {
  const t = useT();
  const expanded = store((state) => state.expanded.includes(entry.id));
  const selected = store((state) => state.selectedId === entry.id);
  const directory = entry.kind === 'directory';
  const linked = entry.kind === 'symlink';
  const Icon = directory ? (expanded ? FolderOpen : Folder) : linked ? Link : File;
  return (
    <li>
      <button
        type="button"
        disabled={linked}
        aria-expanded={directory ? expanded : undefined}
        aria-current={selected ? 'true' : undefined}
        title={linked ? t('files.symlink') : entry.relativePath}
        style={{ paddingLeft: 10 + depth * 14 }}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 pr-3 text-left text-xs outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
          selected && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
        onClick={() =>
          void (directory
            ? store.getState().toggleDirectory(entry.id)
            : store.getState().openFile(entry))
        }
      >
        {directory ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            directory ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          )}
        />
        <span className="truncate">{entry.name}</span>
      </button>
      {directory && expanded && (
        <DirectoryEntries store={store} directoryId={entry.id} depth={depth + 1} />
      )}
    </li>
  );
}
