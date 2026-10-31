import { MAX_COMMIT_MESSAGE_LENGTH } from '@shared/types/orchestration';
import { Loader2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n/I18nProvider';

export function ChangesActionDialog({
  action,
  target,
  branch,
  directory,
  busy,
  error,
  message,
  onMessage,
  onCancel,
  onConfirm,
}: {
  action: 'discard' | 'commit';
  target?: string;
  branch: string;
  directory: string;
  busy: boolean;
  error: string | null;
  message: string;
  onMessage: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  const isCommit = action === 'commit';
  const title = t(
    isCommit
      ? 'orchestration.commitAll'
      : target
        ? 'orchestration.discardFile'
        : 'orchestration.discardAll'
  );
  const validMessage =
    message.trim().length > 0 &&
    message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
    !message.includes('\0');

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent showCloseButton={false} initialFocus={cancel} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words leading-relaxed">
            {isCommit
              ? t('orchestration.commitAllConfirm')
              : target
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
        {isCommit && (
          <div className="space-y-2">
            <label htmlFor={messageId} className="font-medium text-sm">
              {t('orchestration.commitMessage')}
            </label>
            <Textarea
              id={messageId}
              value={message}
              onChange={(event) => onMessage(event.target.value)}
              maxLength={MAX_COMMIT_MESSAGE_LENGTH}
              required
              disabled={busy}
              aria-describedby={`${messageId}-hint`}
            />
            <p id={`${messageId}-hint`} className="text-muted-foreground text-xs">
              {t('orchestration.commitMessageHint', { count: MAX_COMMIT_MESSAGE_LENGTH })}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words text-destructive text-sm">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="text-muted-foreground text-sm">
            {t(isCommit ? 'orchestration.committing' : 'orchestration.discarding')}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={isCommit ? 'default' : 'destructive'}
            disabled={busy || (isCommit && !validMessage)}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="animate-spin" />}
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
