import type { WindowCloseAction } from '@shared/types/ipc';
import { useEffect, useRef, useState } from 'react';
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

export function CloseWindowDialog() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      window.fynvra.window.onCloseRequested(() => {
        setError(null);
        setOpen(true);
      }),
    []
  );
  const respond = async (action: WindowCloseAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.fynvra.window.respondClose(action);
      if (result.ok) setOpen(false);
      else setError(result.error);
    } catch {
      setError(t('app.closeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && void respond('cancel')}>
      <DialogContent
        data-testid="close-window-dialog"
        showCloseButton={false}
        initialFocus={cancel}
        overlayClassName="bg-black/30 dark:bg-black/50"
        className="gap-0 rounded-2xl border-border/80 px-6 py-8 shadow-xl sm:max-w-[31.25rem]"
      >
        <DialogHeader className="gap-3 text-left">
          <DialogTitle className="font-normal text-xl leading-7">{t('app.closeTitle')}</DialogTitle>
          <DialogDescription className="text-base leading-relaxed">
            {t('app.closeDetail')}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter className="mt-12 flex-row justify-end gap-3">
          <Button
            ref={cancel}
            variant="outline"
            className="rounded-xl px-3.5 font-normal text-base"
            disabled={busy}
            onClick={() => void respond('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button
            className="rounded-xl px-3.5 font-normal text-base"
            disabled={busy}
            onClick={() => void respond('tray')}
          >
            {t('app.minimizeToTray')}
          </Button>
          <Button
            variant="destructive"
            className="rounded-xl px-3.5 font-normal text-base"
            disabled={busy}
            onClick={() => void respond('quit')}
          >
            {t('app.quit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
