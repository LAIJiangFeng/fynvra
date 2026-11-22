import type { WorkspaceFileEntry } from '@shared/types/files';
import { FileCode2, GitCompareArrows, MessageSquare, Plus, SquareTerminal, X } from 'lucide-react';
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from 'react';
import { NewSessionButton } from '@/components/chat/NewSessionButton';
import { DiffTabPane } from '@/components/orchestration/DiffTabPane';
import { STATUS_MARK } from '@/components/orchestration/diffView';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MessageId } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type DiffTab, diffTabsStoreFor } from '@/stores/diffTabs';
import { filesStoreFor, isFileDirty } from '@/stores/files';
import { useSourceDiff } from '@/stores/sessionChanges';
import { useTerminalsStore } from '@/stores/terminals';
import {
  ensureWorkspaceTabs,
  markWorkspaceInteraction,
  retryWorkspaceTabs,
  useWorkspaceTabsStore,
  workspaceTabLimitReached,
} from '@/stores/workspaceTabs';
import { FilePane } from './FilePane';
import { TreeContextMenu } from './FileTreeContextMenu';
import { type TabCloseAction, tabsToClose } from './tabClose';
import { WorkspaceTab, WorkspaceTabStrip } from './WorkspaceTabStrip';

/** 中央标签与对话共用空间，切换时不卸载对话或已打开的编辑器。 */
export function FileWorkspace({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const store = filesStoreFor(workspaceId, window.fynvra.files);
  const opened = store((state) => state.opened);
  const selectedId = store((state) => state.selectedId);
  const previews = store((state) => state.previews);
  const diffStore = diffTabsStoreFor(workspaceId);
  const diffTabs = diffStore((state) => state.opened);
  const diffId = diffStore((state) => state.selectedId);
  const allTerminals = useTerminalsStore((state) => state.tabs);
  const terminals = allTerminals.filter((tab) => tab.workspaceId === workspaceId);
  const terminalId = useTerminalsStore((state) => state.selected[workspaceId] ?? null);
  const [closingTerminal, setClosingTerminal] = useState<string | null>(null);
  const persistenceError = useWorkspaceTabsStore(
    (state) => state.views[workspaceId]?.error ?? state.views[workspaceId]?.warning
  );
  const tabsReady = useWorkspaceTabsStore((state) => state.views[workspaceId]?.ready ?? false);
  const selectTerminal = (id: string | null) =>
    useTerminalsStore.getState().select(workspaceId, id);
  const showChat = () => {
    markWorkspaceInteraction(workspaceId);
    selectTerminal(null);
    store.getState().showChat();
  };
  const selectedTab = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<{
    file: WorkspaceFileEntry;
    action: 'close' | 'reload';
  } | null>(null);
  const [menu, setMenu] = useState<{
    tabKey: string;
    keys: string[];
    x: number;
    y: number;
  } | null>(null);
  const [bulk, setBulk] = useState<{ files: string[]; terminals: string[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const t = useT();

  useEffect(() => {
    if (selectedId || diffId || terminalId)
      selectedTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, diffId, terminalId]);

  useEffect(() => {
    void ensureWorkspaceTabs(workspaceId);
  }, [workspaceId]);

  function requestClose(file: WorkspaceFileEntry) {
    if (!tabsReady) return;
    if (!store.getState().closeFile(file.id) && !store.getState().previews[file.id]?.saving)
      setConfirm({ file, action: 'close' });
  }

  /** 单个关闭：与点 × 完全一致 */
  function closeTab(key: string) {
    const id = key.slice(key.indexOf(':') + 1);
    if (key.startsWith('file:')) {
      const file = store.getState().opened.find((entry) => entry.id === id);
      if (file) requestClose(file);
    } else if (key.startsWith('diff:')) diffStore.getState().close(id);
    else if (key.startsWith('terminal:')) {
      const tab = useTerminalsStore.getState().tabs.find((entry) => entry.id === id);
      if (tab?.exited) void useTerminalsStore.getState().close(id);
      else if (tab) setClosingTerminal(id);
    }
  }

  /** 批量关闭：未保存文件和运行中终端留到汇总确认，正在保存的文件跳过 */
  function closeTabs(keys: string[]) {
    if (!tabsReady || keys.length === 0) return;
    markWorkspaceInteraction(workspaceId);
    const files: string[] = [];
    const running: string[] = [];
    for (const key of keys) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('file:')) {
        if (store.getState().previews[id]?.saving) continue;
        if (!store.getState().closeFile(id)) files.push(id);
      } else if (key.startsWith('diff:')) diffStore.getState().close(id);
      else if (key.startsWith('terminal:')) {
        const tab = useTerminalsStore.getState().tabs.find((entry) => entry.id === id);
        if (tab?.exited) void useTerminalsStore.getState().close(id);
        else if (tab) running.push(id);
      }
    }
    if (files.length || running.length) setBulk({ files, terminals: running });
  }

  const menuItem = (action: TabCloseAction, label: MessageId) => {
    const keys = menu ? tabsToClose(menu.keys, menu.tabKey, action) : [];
    const target = menu?.tabKey ?? '';
    return {
      id: action,
      label: t(label),
      // 没有 onSelect 的条目在 TreeContextMenu 里不可选
      onSelect:
        tabsReady && keys.length > 0
          ? () => (action === 'close' ? closeTab(target) : closeTabs(keys))
          : undefined,
    };
  };

  function requestReload(file: WorkspaceFileEntry) {
    if (isFileDirty(store.getState().previews[file.id])) setConfirm({ file, action: 'reload' });
    else void store.getState().reloadFile(file.id);
  }

  const pending = confirm ? previews[confirm.file.id] : undefined;
  /** 非当前面板：保留布局但不可见、不可聚焦、不被读屏（inert） */
  const paneProps = (visible: boolean) => ({
    className: cn(
      'absolute inset-0 flex min-h-0 min-w-0 flex-col',
      !visible && 'invisible pointer-events-none'
    ),
    inert: !visible,
  });
  return (
    <section
      aria-label={t('files.workspace')}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <nav aria-label={t('files.opened')} className="flex h-10 shrink-0 border-b bg-sidebar/60">
        <WorkspaceTabStrip
          workspaceId={workspaceId}
          onTabContextMenu={(tabKey, keys, x, y) => setMenu({ tabKey, keys, x, y })}
        >
          <WorkspaceTab tabKey="chat">
            <button
              type="button"
              aria-pressed={selectedId === null && !terminalId && !diffId}
              onClick={showChat}
              className={cn(
                'flex shrink-0 items-center gap-2 border-r border-t-2 border-t-transparent px-4 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                selectedId === null &&
                  !terminalId &&
                  !diffId &&
                  'border-t-primary bg-background font-medium'
              )}
            >
              <MessageSquare className="size-3.5" />
              {t('files.chat')}
            </button>
          </WorkspaceTab>
          {opened.map((file) => (
            <WorkspaceTab key={file.id} tabKey={`file:${file.id}`}>
              <div
                key={file.id}
                ref={file.id === selectedId ? selectedTab : undefined}
                className={cn(
                  'flex shrink-0 items-center border-r border-t-2 border-t-transparent text-muted-foreground',
                  file.id === selectedId && 'border-t-primary bg-background text-foreground'
                )}
              >
                <button
                  type="button"
                  title={file.relativePath}
                  aria-pressed={file.id === selectedId}
                  className="flex h-full max-w-52 items-center gap-2 pr-1 pl-3 text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => void store.getState().openFile(file)}
                >
                  <FileCode2 className="size-3.5 shrink-0" />
                  <span className="truncate">{file.name}</span>
                  {isFileDirty(previews[file.id]) && (
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-500">
                      <span className="sr-only">{t('files.unsaved')}</span>
                    </span>
                  )}
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="mx-1 size-6"
                  disabled={!tabsReady || previews[file.id]?.saving}
                  aria-label={t('files.closeFile', { name: file.name })}
                  onClick={() => requestClose(file)}
                >
                  <X className="size-3" />
                </Button>
              </div>
            </WorkspaceTab>
          ))}
          {diffTabs.map((tab) => (
            <WorkspaceTab key={tab.id} tabKey={`diff:${tab.id}`}>
              <DiffWorkspaceTab
                key={tab.id}
                tab={tab}
                active={tab.id === diffId}
                tabRef={tab.id === diffId ? selectedTab : undefined}
                onSelect={() => diffStore.getState().select(tab.id)}
                onClose={() => diffStore.getState().close(tab.id)}
              />
            </WorkspaceTab>
          ))}
          {terminals.map((tab) => (
            <WorkspaceTab key={tab.id} tabKey={`terminal:${tab.id}`}>
              <div
                key={tab.id}
                ref={tab.id === terminalId ? selectedTab : undefined}
                className={cn(
                  'flex shrink-0 items-center border-r border-t-2 border-t-transparent text-muted-foreground',
                  tab.id === terminalId && 'border-t-primary bg-background text-foreground'
                )}
              >
                <button
                  type="button"
                  aria-pressed={tab.id === terminalId}
                  className="flex h-full items-center gap-2 pr-1 pl-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => {
                    store.getState().showChat();
                    selectTerminal(tab.id);
                  }}
                >
                  <SquareTerminal className="size-3.5" />
                  {t('files.terminal')} {tab.number}
                  {tab.exited && (
                    <span className="text-muted-foreground">{t('terminals.finished')}</span>
                  )}
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="mx-1 size-6"
                  aria-label={t('terminals.closeTitle')}
                  onClick={() => {
                    if (tab.exited) void useTerminalsStore.getState().close(tab.id);
                    else setClosingTerminal(tab.id);
                  }}
                >
                  <X className="size-3" />
                </Button>
              </div>
            </WorkspaceTab>
          ))}
        </WorkspaceTabStrip>
        <NewSessionButton>
          {(openChat) => (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="m-1 shrink-0"
                    aria-label={t('files.newTab')}
                    title={t('files.newTab')}
                  />
                }
              >
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-36">
                <DropdownMenuItem onClick={openChat}>
                  <MessageSquare />
                  {t('files.chat')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!tabsReady}
                  onClick={() => {
                    if (workspaceTabLimitReached(workspaceId)) return;
                    markWorkspaceInteraction(workspaceId);
                    store.getState().showChat();
                    void useTerminalsStore.getState().create(workspaceId);
                  }}
                >
                  <SquareTerminal />
                  {t('files.terminal')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </NewSessionButton>
      </nav>
      {persistenceError && (
        <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {persistenceError}
          <Button
            size="sm"
            variant="ghost"
            className="ml-2 h-6"
            onClick={() => void retryWorkspaceTabs(workspaceId)}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {/* 面板叠放、非当前的只隐身不 display:none，切回来不用整块重新布局（聊天首滑卡顿） */}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div {...paneProps(selectedId === null && !terminalId && !diffId)}>{children}</div>
        {opened.map((file) => (
          <div key={file.id} {...paneProps(selectedId === file.id)}>
            {tabsReady ? (
              <FilePane
                file={file}
                store={store}
                active={selectedId === file.id}
                onReload={() => requestReload(file)}
              />
            ) : (
              <div role="status" className="m-auto p-6 text-muted-foreground text-sm">
                {t('common.loading')}
              </div>
            )}
          </div>
        ))}
        {diffTabs.map((tab) => (
          <div key={tab.id} {...paneProps(diffId === tab.id)}>
            <DiffTabPane tab={tab} />
          </div>
        ))}
        {terminals.map((tab) => (
          <div key={tab.id} {...paneProps(terminalId === tab.id)}>
            <TerminalPane id={tab.id} active={terminalId === tab.id} />
          </div>
        ))}
      </div>
      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...(menu.tabKey === 'chat' ? [] : [menuItem('close', 'workspaceTabs.close')]),
            menuItem('others', 'workspaceTabs.closeOthers'),
            menuItem('left', 'workspaceTabs.closeLeft'),
            menuItem('right', 'workspaceTabs.closeRight'),
          ]}
          onClose={closeMenu}
        />
      )}
      <Dialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workspaceTabs.bulkCloseTitle')}</DialogTitle>
            <DialogDescription>
              {t('workspaceTabs.bulkCloseHint', {
                files: bulk?.files.length ?? 0,
                terminals: bulk?.terminals.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulk(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (bulk) {
                  // closeFile 对正在保存的文件返回 false，自然跳过
                  for (const id of bulk.files) store.getState().closeFile(id, true);
                  for (const id of bulk.terminals) void useTerminalsStore.getState().close(id);
                }
                setBulk(null);
              }}
            >
              {t('workspaceTabs.closeAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={closingTerminal !== null}
        onOpenChange={(open) => {
          if (!open) setClosingTerminal(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('terminals.closeTitle')}</DialogTitle>
            <DialogDescription>{t('terminals.closeHint')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingTerminal(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (closingTerminal) void useTerminalsStore.getState().close(closingTerminal);
                setClosingTerminal(null);
              }}
            >
              {t('terminals.closeTitle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending?.saving) setConfirm(null);
        }}
      >
        <DialogContent showCloseButton={!pending?.saving}>
          <DialogHeader>
            <DialogTitle>
              {t(confirm?.action === 'reload' ? 'files.reloadTitle' : 'files.closeTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('files.unsavedHint', { name: confirm?.file.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {pending?.saveError && (
            <p role="alert" className="text-destructive text-sm">
              {t(`files.errors.${pending.saveError}`)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending?.saving} onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={pending?.saving}
              onClick={() => {
                if (!confirm) return;
                if (confirm.action === 'close') store.getState().closeFile(confirm.file.id, true);
                else void store.getState().reloadFile(confirm.file.id, true);
                setConfirm(null);
              }}
            >
              {t(confirm?.action === 'reload' ? 'files.discardReload' : 'files.discard')}
            </Button>
            {confirm?.action === 'close' && (
              <Button
                disabled={pending?.saving}
                onClick={async () => {
                  if (await store.getState().saveFile(confirm.file.id)) {
                    if (store.getState().closeFile(confirm.file.id)) setConfirm(null);
                  }
                }}
              >
                {t(pending?.saving ? 'files.saving' : 'files.saveClose')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DiffWorkspaceTab({
  tab,
  active,
  tabRef,
  onSelect,
  onClose,
}: {
  tab: DiffTab;
  active: boolean;
  tabRef?: Ref<HTMLDivElement>;
  onSelect: () => void;
  onClose: () => void;
}) {
  const entry = useSourceDiff(tab.source);
  const branch = entry?.status === 'ready' ? entry.data.branch : undefined;
  const name = tab.path.slice(tab.path.lastIndexOf('/') + 1);
  const path = tab.oldPath ? `${tab.oldPath} → ${tab.path}` : tab.path;
  const mark = STATUS_MARK[tab.status];
  const t = useT();
  const section = t(
    tab.section === 'committed'
      ? 'orchestration.committedChanges'
      : 'orchestration.uncommittedChanges'
  );

  return (
    <div
      ref={tabRef}
      className={cn(
        'flex shrink-0 items-center border-r border-t-2 border-t-transparent text-muted-foreground',
        active && 'border-t-primary bg-background text-foreground'
      )}
    >
      <button
        type="button"
        title={[path, branch, section].filter(Boolean).join('\n')}
        aria-pressed={active}
        className="flex h-full max-w-52 items-center gap-2 pr-1 pl-3 text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onSelect}
      >
        <GitCompareArrows className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
        <span className={cn('shrink-0 font-mono font-semibold', mark.className)}>
          <span aria-hidden>{mark.letter}</span>
          <span className="sr-only">{t(`orchestration.fileStatus.${tab.status}`)}</span>
        </span>
      </button>
      <Button
        size="icon-xs"
        variant="ghost"
        className="mx-1 size-6"
        aria-label={t('orchestration.closeDiff', { name })}
        onClick={onClose}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
