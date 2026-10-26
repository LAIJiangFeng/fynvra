import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n/I18nProvider';
import { instructionCall, instructionsApi } from '@/lib/api/instructions';
import type { InstructionEntry, InstructionScan } from '../../../preload/domains/instructions';
import { Field, InlineMessage } from './common';
import { instructionSize, instructionSourceLabel } from './instructions';

export function InstructionEditorDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: InstructionEntry | null;
  onClose(): void;
  onSaved(): void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(entry?.name ?? '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(entry !== null);
  const [ready, setReady] = useState(entry === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!entry) return;
    let active = true;
    void instructionCall(() => instructionsApi.read(entry.id)).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.ok) {
        setName(result.entry.name);
        setContent(result.content);
        setReady(true);
      } else setError(result.error);
    });
    return () => {
      active = false;
    };
  }, [entry]);

  const save = async () => {
    if (!ready || busy || !name.trim()) return;
    setBusy(true);
    const result = await instructionCall(() =>
      instructionsApi.save({ ...(entry ? { id: entry.id } : {}), name, content })
    );
    setBusy(false);
    if (result.ok) onSaved();
    else setError(result.error);
  };
  const pick = async () => {
    setBusy(true);
    const result = await instructionCall(() => instructionsApi.pick());
    setBusy(false);
    if (result.ok && !result.canceled) onSaved();
    else if (!result.ok) setError(result.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(entry ? 'settings.instructions.edit' : 'settings.instructions.add')}
          </DialogTitle>
          <DialogDescription>
            {t(
              entry?.kind === 'linked'
                ? 'settings.instructions.editLinkedHint'
                : 'settings.instructions.localHint'
            )}
          </DialogDescription>
        </DialogHeader>
        {loading && <p className="text-muted-foreground text-sm">{t('common.loading')}</p>}
        <Field label={t('settings.instructions.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            disabled={!ready || busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t('settings.instructions.content')}
          htmlFor={`${id}-content`}
          hint={t('settings.instructions.chars', { count: content.length })}
        >
          <Textarea
            id={`${id}-content`}
            value={content}
            rows={16}
            spellCheck={false}
            disabled={!ready || busy}
            className="max-h-[50vh] min-h-56 font-mono text-xs"
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <DialogFooter>
          {!entry && (
            <Button variant="outline" disabled={busy} onClick={() => void pick()}>
              {t('settings.instructions.pick')}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ready || busy || !name.trim()} onClick={() => void save()}>
            {t(busy ? 'common.saving' : 'common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstructionImportDialog({
  onClose,
  onImported,
}: {
  onClose(): void;
  onImported(): void;
}) {
  const t = useT();
  const [scan, setScan] = useState<InstructionScan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void instructionCall(() => instructionsApi.scan()).then((result) => {
      if (!active) return;
      if (result.ok) {
        setScan(result);
        setSelected(result.candidates.filter((item) => !item.registered).map((item) => item.id));
      } else setError(result.error);
    });
    return () => {
      active = false;
    };
  }, []);
  const submit = async () => {
    setBusy(true);
    const result = await instructionCall(() => instructionsApi.import({ candidateIds: selected }));
    setBusy(false);
    if (result.ok) onImported();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.instructions.import')}</DialogTitle>
          <DialogDescription>{t('settings.instructions.importHint')}</DialogDescription>
        </DialogHeader>
        {!scan && !error && <p className="text-muted-foreground text-sm">{t('common.loading')}</p>}
        {scan?.candidates.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('settings.instructions.noneFound')}</p>
        )}
        <ul className="max-h-[50vh] divide-y overflow-y-auto">
          {scan?.candidates.map((candidate) => (
            <li key={candidate.id}>
              <label className="flex cursor-pointer items-start gap-3 py-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={busy || candidate.registered}
                  checked={selected.includes(candidate.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, candidate.id]
                        : current.filter((value) => value !== candidate.id)
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>{candidate.name}</span>
                    <Badge variant="outline">{instructionSourceLabel(candidate.source, t)}</Badge>
                    {candidate.registered && <Badge>{t('settings.instructions.registered')}</Badge>}
                  </div>
                  <p className="break-all font-mono text-muted-foreground text-xs">
                    {candidate.path}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {instructionSize(candidate.size)} ·{' '}
                    {t('settings.instructions.chars', { count: candidate.charCount })}
                  </p>
                </div>
              </label>
            </li>
          ))}
        </ul>
        {scan?.warnings.map((warning) => (
          <InlineMessage key={warning} tone="error">
            {warning}
          </InlineMessage>
        ))}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy || selected.length === 0} onClick={() => void submit()}>
            {t('settings.instructions.importSelected', { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
