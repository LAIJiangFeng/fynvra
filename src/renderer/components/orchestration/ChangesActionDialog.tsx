import { Loader2 } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';

export function ChangesActionDialog({
  target,
  branch,
  directory,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  target?: string;
  branch: string;
  directory: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const title = t(target ? 'orchestration.discardFile' : 'orchestration.discardAll');

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent showCloseButton={false} initialFocus={cancel} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words leading-relaxed">
            {target
              ? t('orchestration.discardFileConfirm', { name: target })
              : t('orchestration.discardAllConfirm')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
          <p className="break-all">{t('orchestration.changesSource', { directory })}</p>
          <p className="break-all">
            {t('orchestration.changesBranch', {
              branch: branch || t('orchestration.detachedHead'),
            })}
          </p>
        </div>
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words text-destructive text-sm">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="text-muted-foreground text-sm">
            {t('orchestration.discarding')}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="animate-spin" />}
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
