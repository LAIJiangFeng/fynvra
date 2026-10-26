import type { WorkspaceFileEntry } from '@shared/types/files';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  ConfirmDeleteDialog,
  MENU_ICONS,
  type MenuItem,
  NameDialog,
  TreeContextMenu,
} from '@/components/files/FileTreeContextMenu';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type FilesStore, ROOT_DIRECTORY_ID } from '@/stores/files';

/** 右键菜单的目标：条目为 null 时是目录空白处（在根目录新建）。 */
interface MenuTarget {
  x: number;
  y: number;
  entry: WorkspaceFileEntry | null;
  parentId: string | undefined;
}

/** 新建 / 重命名对话框的目标。 */
interface NameTarget {
  kind: 'create' | 'rename';
  entryKind: 'file' | 'directory';
  parentId: string | undefined;
  entry?: WorkspaceFileEntry;
}

/** 右栏浏览目录（支持右键菜单变更条目）；文件内容由中央工作区承载。 */
export function FilesView({ store, workspaceName }: { store: FilesStore; workspaceName: string }) {
  const t = useT();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [nameTarget, setNameTarget] = useState<NameTarget | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceFileEntry | null>(null);

  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  const clipboardCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板被占用（如另一个应用持锁）：静默失败，复制路径另有按钮途径
    }
  };

  const menuItems = (target: MenuTarget): MenuItem[] => {
    const { entry, parentId } = target;
    const separator: MenuItem = { id: 'sep' };
    if (!entry) {
      return [
        {
          id: 'new-file',
          label: t('files.menu.newFile'),
          icon: MENU_ICONS.newFile,
          onSelect: () => setNameTarget({ kind: 'create', entryKind: 'file', parentId }),
        },
        {
          id: 'new-folder',
          label: t('files.menu.newFolder'),
          icon: MENU_ICONS.newFolder,
          onSelect: () => setNameTarget({ kind: 'create', entryKind: 'directory', parentId }),
        },
      ];
    }
    const items: MenuItem[] = [];
    if (entry.kind === 'directory') {
      items.push(
        {
          id: 'new-file',
          label: t('files.menu.newFile'),
          icon: MENU_ICONS.newFile,
          onSelect: () => setNameTarget({ kind: 'create', entryKind: 'file', parentId: entry.id }),
        },
        {
          id: 'new-folder',
          label: t('files.menu.newFolder'),
          icon: MENU_ICONS.newFolder,
          onSelect: () =>
            setNameTarget({ kind: 'create', entryKind: 'directory', parentId: entry.id }),
        },
        separator
      );
    } else if (entry.kind === 'file') {
      items.push(
        {
          id: 'view',
          label: t('files.menu.view'),
          icon: MENU_ICONS.view,
          onSelect: () => void store.getState().openFile(entry),
        },
        separator
      );
    }
    items.push({
      id: 'copy',
      label: t('files.menu.copy'),
      icon: MENU_ICONS.copy,
      onSelect: () => void store.getState().copyEntry(entry),
    });
    items.push(
      {
        id: 'copy-path',
        label: t('files.menu.copyPath'),
        icon: MENU_ICONS.copyPath,
        onSelect: () => {
          void store
            .getState()
            .resolvePath(entry)
            .then((result) => {
              if (result.ok) void clipboardCopy(result.path);
            });
        },
      },
      {
        id: 'copy-relative-path',
        label: t('files.menu.copyRelativePath'),
        icon: MENU_ICONS.copyPath,
        onSelect: () => void clipboardCopy(entry.relativePath),
      }
    );
    if (entry.kind === 'file') {
      items.push({
        id: 'duplicate',
        label: t('files.menu.duplicate'),
        icon: MENU_ICONS.duplicate,
        onSelect: () => void store.getState().duplicateFile(parentId, entry),
      });
    }
    items.push(
      separator,
      {
        id: 'reveal',
        label: t('files.menu.reveal'),
        onSelect: () => void store.getState().revealEntry(entry),
      },
      {
        id: 'rename',
        label: t('files.menu.rename'),
        icon: MENU_ICONS.rename,
        onSelect: () =>
          setNameTarget({
            kind: 'rename',
            entryKind: entry.kind as 'file' | 'directory',
            parentId,
            entry,
          }),
      },
      {
        id: 'remove',
        label: t('files.menu.remove'),
        icon: MENU_ICONS.remove,
        danger: true,
        onSelect: () => setDeleting(entry),
      }
    );
    return items;
  };

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
        <nav
          aria-label={t('files.explorer')}
          className="min-h-0 flex-1 overflow-auto pb-2"
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest('[data-entry-id]')) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, entry: null, parentId: undefined });
          }}
        >
          <DirectoryEntries store={store} depth={0} onContextMenu={setMenu} />
        </nav>
      </section>

      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {nameTarget && (
        <NameDialog
          title={t(
            nameTarget.kind === 'create'
              ? nameTarget.entryKind === 'file'
                ? 'files.menu.newFile'
                : 'files.menu.newFolder'
              : 'files.renameTitle',
            nameTarget.entry ? { name: nameTarget.entry.name } : undefined
          )}
          initial={nameTarget.kind === 'rename' ? (nameTarget.entry?.name ?? '') : ''}
          confirmLabel={t(nameTarget.kind === 'create' ? 'common.create' : 'common.save')}
          busyLabel={t('common.working')}
          onConfirm={async (name) => {
            const state = store.getState();
            const result =
              nameTarget.kind === 'create'
                ? await state.createEntry(nameTarget.parentId, name, nameTarget.entryKind)
                : nameTarget.entry
                  ? await state.renameEntry(nameTarget.parentId, nameTarget.entry, name)
                  : null;
            if (!result || result.ok) return null;
            return result.error === 'restartRequired' ? 'unavailable' : result.error;
          }}
          onClose={() => setNameTarget(null)}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          name={deleting.name}
          onDelete={async () => {
            const result = await store
              .getState()
              .deleteEntry(parentIdOf(store, deleting), deleting);
            if (result.ok) return null;
            return result.error === 'restartRequired' ? 'unavailable' : result.error;
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** 删除确认时反查条目所在目录 id：树是按层渲染的，从展开的目录里找到包含它的那层。 */
function parentIdOf(store: FilesStore, entry: WorkspaceFileEntry): string | undefined {
  const state = store.getState();
  const prefix = entry.relativePath.includes('/')
    ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'))
    : '';
  if (!prefix) return undefined;
  const parent = Object.values(state.directories)
    .flatMap((directory) => directory.entries)
    .find((candidate) => candidate.kind === 'directory' && candidate.relativePath === prefix);
  return parent?.id;
}

function DirectoryEntries({
  store,
  directoryId,
  depth,
  onContextMenu,
}: {
  store: FilesStore;
  directoryId?: string;
  depth: number;
  onContextMenu(target: MenuTarget): void;
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
        <FileRow
          key={entry.id}
          entry={entry}
          store={store}
          depth={depth}
          parentDirectoryId={directoryId}
          onContextMenu={onContextMenu}
        />
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
  parentDirectoryId,
  onContextMenu,
}: {
  entry: WorkspaceFileEntry;
  store: FilesStore;
  depth: number;
  parentDirectoryId: string | undefined;
  onContextMenu(target: MenuTarget): void;
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
        data-entry-id={entry.id}
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
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu({
            x: event.clientX,
            y: event.clientY,
            entry,
            parentId: parentDirectoryId,
          });
        }}
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
        <DirectoryEntries
          store={store}
          directoryId={entry.id}
          depth={depth + 1}
          onContextMenu={onContextMenu}
        />
      )}
    </li>
  );
}
