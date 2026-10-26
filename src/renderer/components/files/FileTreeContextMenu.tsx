import type { FileError } from '@shared/types/files';
import {
  ClipboardCopy,
  Copy,
  Eye,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 右键菜单条目；label 为空表示分隔线。 */
export interface MenuItem {
  id: string;
  label?: string;
  icon?: ComponentType<{ className?: string }>;
  danger?: boolean;
  onSelect?(): void;
}

/**
 * 目录树的右键菜单：固定定位在光标处，点击外部 / Escape / 失焦关闭，方向键 + Enter 键盘可达。
 * base-ui 没有 ContextMenu 原语，这里保持最小实现。
 */
export function TreeContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const selectable = items.map((item, index) => (item.label && item.onSelect ? index : -1));

  useEffect(() => menuRef.current?.focus(), []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = (delta: number) => {
    const candidates = selectable.filter((index) => index >= 0);
    if (candidates.length === 0) return;
    const position = candidates.indexOf(active);
    const next =
      candidates[(position + delta + candidates.length * 2) % candidates.length] ?? candidates[0];
    setActive(next);
    requestAnimationFrame(() =>
      (
        menuRef.current?.querySelectorAll('[role="menuitem"]')[candidates.indexOf(next)] as
          | HTMLElement
          | undefined
      )?.focus()
    );
  };

  const maxLeft = Math.max(0, window.innerWidth - 220);
  const maxTop = Math.max(0, window.innerHeight - items.length * 30 - 16);

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      style={{ left: Math.min(x, maxLeft), top: Math.min(y, maxTop) }}
      className="no-drag fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Enter' && active >= 0) {
          event.preventDefault();
          onClose();
          items[active]?.onSelect?.();
        }
      }}
    >
      {items.map((item, index) =>
        item.label ? (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent',
              item.danger && 'text-destructive'
            )}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
            onMouseEnter={() => setActive(selectable.indexOf(index))}
          >
            {item.icon && <item.icon className="size-3.5 shrink-0" />}
            {item.label}
          </button>
        ) : (
          <hr key={item.id} className="mx-1 my-1 h-px border-0 bg-border" />
        )
      )}
    </div>
  );
}

/** 菜单图标（供 FilesView 组装条目用）。 */
export const MENU_ICONS = {
  newFile: FilePlus2,
  newFolder: FolderPlus,
  copy: Copy,
  copyPath: ClipboardCopy,
  duplicate: Copy,
  view: Eye,
  reveal: FolderOpen,
  rename: Pencil,
  remove: Trash2,
} as const;

/** 重命名输入框：确认时调用 action，返回错误文案键则展示错误并保持打开。 */
export function NameDialog({
  title,
  description,
  initial = '',
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  initial?: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm(name: string): Promise<FileError | null>;
  onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FileError | null>(null);
  const t = useT();

  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const failure = await onConfirm(name);
    setBusy(false);
    if (failure !== null) setError(failure);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          aria-label={title}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          onFocus={(event) => event.target.select()}
        />
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {t(`files.errors.${error}`)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 删除确认：删除只进系统回收站，可在回收站恢复。 */
export function ConfirmDeleteDialog({
  name,
  onDelete,
  onClose,
}: {
  name: string;
  onDelete(): Promise<FileError | null>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FileError | null>(null);
  const t = useT();
  const del = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onDelete();
      if (failure !== null) setError(failure);
      else onClose();
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('files.deleteTitle', { name })}</DialogTitle>
          <DialogDescription>{t('files.deleteHint')}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {t(`files.errors.${error}`)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void del()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('files.menu.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
