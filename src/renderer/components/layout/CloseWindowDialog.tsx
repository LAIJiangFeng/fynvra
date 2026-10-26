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
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('app.closeTitle')}</DialogTitle>
          <DialogDescription className="leading-relaxed">{t('app.closeDetail')}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            ref={cancel}
            variant="outline"
            disabled={busy}
            onClick={() => void respond('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void respond('tray')}>
            {t('app.minimizeToTray')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void respond('quit')}>
            {t('app.quit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
