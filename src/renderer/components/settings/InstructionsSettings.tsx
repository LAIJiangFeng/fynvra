import type { IpcResult } from '@shared/types/ipc';
import { FileText, Pencil, Plus, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { instructionCall, instructionsApi } from '@/lib/api/instructions';
import { useInstructionsStore } from '@/stores/instructions';
import type { InstructionEntry } from '../../../preload/domains/instructions';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { InstructionEditorDialog, InstructionImportDialog } from './InstructionDialogs';
import { instructionSize, instructionSourceLabel } from './instructions';

export function InstructionsSettings() {
  const t = useT();
  const entries = useInstructionsStore((state) => state.entries);
  const loaded = useInstructionsStore((state) => state.loaded);
  const loadError = useInstructionsStore((state) => state.error);
  const refresh = useInstructionsStore((state) => state.refresh);
  const [editing, setEditing] = useState<{ entry: InstructionEntry | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<InstructionEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (operation: () => Promise<IpcResult>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await instructionCall(operation);
    setBusy(false);
    if (result.ok) {
      setRemoving(null);
      await refresh();
    } else setError(result.error);
  };
  const saved = () => {
    setEditing(null);
    setImporting(false);
    void refresh();
  };
  const active = entries.find((entry) => entry.enabled);
  return (
    <section>
      <SectionHeader title={t('settings.instructions.title')}>
        <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
          <ScanSearch />
          {t('settings.instructions.import')}
        </Button>
        <Button size="sm" onClick={() => setEditing({ entry: null })}>
          <Plus />
          {t('settings.instructions.add')}
        </Button>
      </SectionHeader>
      <p className="text-muted-foreground text-sm">{t('settings.instructions.subtitle')}</p>
      <p className="mt-1 text-muted-foreground text-xs">
        {t('settings.instructions.exclusiveHint')}
      </p>
      <div className="my-3 flex items-center justify-between text-muted-foreground text-xs">
        <span>{t('settings.instructions.activeChars', { count: active?.charCount ?? 0 })}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('settings.instructions.refresh')}
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
      </div>
      {(error || loadError) && <InlineMessage tone="error">{error ?? loadError}</InlineMessage>}
      {!loaded && <p className="text-muted-foreground text-sm">{t('common.loading')}</p>}
      {loaded && entries.length === 0 ? (
        <EmptyState icon={FileText} title={t('settings.instructions.empty')} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`font-medium text-sm ${entry.enabled ? '' : 'text-muted-foreground line-through'}`}
                  >
                    {entry.name}
                  </span>
                  <Badge variant="outline">{instructionSourceLabel(entry.source, t)}</Badge>
                  <Badge>
                    {t(
                      entry.kind === 'linked'
                        ? 'settings.instructions.linked'
                        : 'settings.instructions.local'
                    )}
                  </Badge>
                </div>
                {(entry.kind === 'linked' || entry.importedFrom) && (
                  <p className="mt-1 break-all font-mono text-muted-foreground text-xs">
                    {entry.kind === 'linked'
                      ? entry.path
                      : t('settings.instructions.importedFrom', { path: entry.importedFrom ?? '' })}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground text-xs">
                  {instructionSize(entry.size)} ·{' '}
                  {t('settings.instructions.chars', { count: entry.charCount })}
                </p>
                {entry.warning && (
                  <p className="mt-1 break-all text-destructive text-xs" title={entry.warning}>
                    {t('settings.instructions.unreadable')} {entry.warning}
                  </p>
                )}
              </div>
              <Switch
                className="mt-1"
                checked={entry.enabled}
                disabled={busy}
                aria-label={t('common.enableItem', { name: entry.name })}
                onCheckedChange={(enabled) =>
                  void mutate(() => instructionsApi.toggle({ id: entry.id, enabled }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy}
                aria-label={t('settings.instructions.editItem', { name: entry.name })}
                onClick={() => setEditing({ entry })}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy}
                aria-label={t('common.removeItem', { name: entry.name })}
                onClick={() => {
                  setError(null);
                  setRemoving(entry);
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <InstructionEditorDialog
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
      {importing && (
        <InstructionImportDialog onClose={() => setImporting(false)} onImported={saved} />
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings.instructions.removeTitle', { name: removing?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('settings.instructions.removeHint')}</DialogDescription>
          </DialogHeader>
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (removing) void mutate(() => instructionsApi.remove(removing.id));
              }}
            >
              {t('common.confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
