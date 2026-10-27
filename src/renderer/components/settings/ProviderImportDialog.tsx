import { providerApiLabel, resolveBaseUrl } from '@shared/modelCatalog';
import type {
  ModelProviderView,
  ProviderImportCandidate,
  ProviderImportSource,
  RemoteModelEntry,
} from '@shared/types/llm';
import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers';
import type { ProviderImportResult } from '../../../preload/domains/providers';
import { InlineMessage, WarningList } from './common';
import { draftFromProvider, draftToUpsertInput } from './providerForm';
import {
  advanceImportModelQueue,
  createImportModelQueue,
  defaultSelection,
  duplicateBadge,
  duplicateReason,
  IMPORT_SOURCES,
  type ImportModelQueue,
  importSummary,
  invertSelection,
  modelSummary,
  orderedSelection,
  selectAll,
  sourceLabel,
  toggleSource,
} from './providerImport';
import { RemoteModelsPicker } from './RemoteModelsPicker';
import { mergeRemoteModels, type RemoteModelsRequest } from './remoteModels';
import { maskSecrets } from './secretMask';

export type ImportStatus = { tone: 'success' | 'error'; text: string };

/** 从本机 Claude Code / Codex / CC Switch 导入模型服务。每次打开（session 变化）重新扫描。 */
export function ProviderImportDialog({
  session,
  onClose,
  onImported,
}: {
  /** 打开时是本次导入的序号，关闭时为 null */
  session: number | null;
  onClose: () => void;
  onImported: (status: ImportStatus) => void;
}) {
  // 关闭动画期间沿用上一次的内容，避免弹窗闪成空白
  const [shown, setShown] = useState(session);
  if (session !== null && session !== shown) setShown(session);

  return shown === null ? null : (
    <ImportSession key={shown} open={session !== null} onClose={onClose} onImported={onImported} />
  );
}

type ImportedResult = Extract<ProviderImportResult, { ok: true }>;

function ImportSession({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (status: ImportStatus) => void;
}) {
  const [queue, setQueue] = useState<ImportModelQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = useProvidersStore((state) => state.providers);
  const queued = queue?.providers[queue.index];
  const provider = queued && (providers.find(({ id }) => id === queued.id) ?? queued);

  const advance = (action: 'saved' | 'skip' | 'skip-all') => {
    if (!queue) return;
    const next = advanceImportModelQueue(queue, action);
    if (next) setQueue(next);
    else onClose();
  };

  const imported = (result: ImportedResult) => {
    onImported({
      tone: result.imported.length > 0 ? 'success' : 'error',
      text: importSummary(result),
    });
    const next = createImportModelQueue(result.imported);
    if (next) setQueue(next);
    else onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        if (busy || queue) details.cancel();
        if (busy) return;
        // 关闭当前选择器（包括 Escape / 遮罩）等同于跳过当前服务。
        if (queue) advance('skip');
        else onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!busy}
      >
        {provider && queue ? (
          <ImportedProviderModels
            key={provider.id}
            provider={provider}
            position={queue.index + 1}
            total={queue.providers.length}
            busy={busy}
            onBusyChange={setBusy}
            onSaved={() => advance('saved')}
            onSkip={() => advance('skip')}
            onSkipAll={() => advance('skip-all')}
          />
        ) : (
          <ImportContent onImported={imported} onBusyChange={setBusy} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 复用编辑服务时的选择器、合并与保存路径；跳过时只丢弃本地草稿。 */
function ImportedProviderModels({
  provider,
  position,
  total,
  busy,
  onBusyChange,
  onSaved,
  onSkip,
  onSkipAll,
}: {
  provider: ModelProviderView;
  position: number;
  total: number;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
  onSkip: () => void;
  onSkipAll: () => void;
}) {
  const upsert = useProvidersStore((state) => state.upsert);
  const loadModelOptions = useProvidersStore((state) => state.loadModelOptions);
  const [draft, setDraft] = useState(() => draftFromProvider(provider));
  // 已导入的服务只传 id，key 始终留在 Main；request 在当前服务内保持稳定。
  const [request] = useState<RemoteModelsRequest>({
    ok: true,
    input: { providerId: provider.id },
  });
  const [reload, setReload] = useState(0);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void loadModelOptions();
  }, [loadModelOptions]);

  const addRemote = (picked: RemoteModelEntry[]) => {
    const result = mergeRemoteModels(draft.models, picked);
    setDraft((current) => ({ ...current, models: result.models }));
    if (result.added > 0) setAdded(true);
    setError(null);
    return result;
  };

  const save = async () => {
    const result = draftToUpsertInput(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onBusyChange(true);
    const saved = await upsert(result.input);
    onBusyChange(false);
    if (saved.ok) onSaved();
    else setError(saved.error);
  };

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>
          {t('settings.providers.importModelsTitle', { name: provider.name, position, total })}
        </DialogTitle>
        <DialogDescription>{t('settings.providers.importModelsHint')}</DialogDescription>
      </DialogHeader>
      <fieldset disabled={busy} aria-busy={busy} className="grid min-w-0 gap-4">
        <RemoteModelsPicker
          key={reload}
          request={request}
          current={draft.models}
          onAdd={addRemote}
          onReload={() => setReload((current) => current + 1)}
          onClose={onSkip}
          closeLabel={t('settings.providers.skipModels')}
        />
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <DialogFooter>
          <Button variant="ghost" onClick={onSkipAll}>
            {t('settings.providers.skipAllModels')}
          </Button>
          <Button variant="outline" onClick={onSkip}>
            {t('settings.providers.skipModels')}
          </Button>
          <Button disabled={!added || busy} onClick={() => void save()}>
            {t(busy ? 'common.saving' : 'settings.providers.saveModelsAndContinue')}
          </Button>
        </DialogFooter>
      </fieldset>
    </div>
  );
}

type ScanState =
  | { phase: 'scanning' }
  | { phase: 'done'; candidates: ProviderImportCandidate[]; warnings: string[] }
  | { phase: 'failed'; error: string };

function ImportContent({
  onImported,
  onBusyChange,
}: {
  onImported: (result: ImportedResult) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const scanImports = useProvidersStore((state) => state.scanImports);
  const importCandidates = useProvidersStore((state) => state.importCandidates);
  const idPrefix = useId();
  // 「重新扫描」放回一个新数组：引用变了，下面的 effect 就会再扫一次
  const [sources, setSources] = useState<ProviderImportSource[]>(() =>
    IMPORT_SOURCES.map((source) => source.id)
  );
  const [scan, setScan] = useState<ScanState>({ phase: 'scanning' });
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const t = useT();

  // 只认最后一次扫描的返回；Main 也按顺序扫，它缓存的正是这一次的结果
  useEffect(() => {
    if (sources.length === 0) return;
    let active = true;
    setScan({ phase: 'scanning' });
    setImportError(null);
    void scanImports(sources).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setScan({ phase: 'failed', error: result.error });
        return;
      }
      setScan({ phase: 'done', candidates: result.candidates, warnings: result.warnings });
      setSelected(defaultSelection(result.candidates));
    });
    return () => {
      active = false;
    };
  }, [scanImports, sources]);

  const candidates = scan.phase === 'done' ? scan.candidates : [];
  const ready = sources.length > 0 && scan.phase === 'done';

  const runImport = async () => {
    setImporting(true);
    onBusyChange(true);
    setImportError(null);
    const result = await importCandidates(orderedSelection(candidates, selected));
    setImporting(false);
    onBusyChange(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    onImported(result);
  };

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{t('settings.providers.importTitle')}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {IMPORT_SOURCES.map((source) => (
          <label
            key={source.id}
            htmlFor={`${idPrefix}-${source.id}`}
            className="flex cursor-pointer items-center gap-2 text-sm"
            title={source.path}
          >
            <Checkbox
              id={`${idPrefix}-${source.id}`}
              checked={sources.includes(source.id)}
              onCheckedChange={(on) =>
                setSources((current) => toggleSource(current, source.id, on))
              }
            />
            {source.label}
          </label>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={sources.length === 0 || scan.phase === 'scanning'}
          onClick={() => setSources((current) => [...current])}
        >
          <RefreshCw />
          {t('settings.import.rescan')}
        </Button>
      </div>

      {sources.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">
          {t('settings.import.pickSource')}
        </p>
      ) : scan.phase === 'scanning' ? (
        <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.import.scanning')}
        </p>
      ) : scan.phase === 'failed' ? (
        <InlineMessage tone="error">{scan.error}</InlineMessage>
      ) : candidates.length === 0 ? (
        <p className="py-6 text-center text-sm">{t('settings.providers.importNone')}</p>
      ) : (
        <div className="grid min-w-0 gap-2">
          <div className="flex items-center justify-between text-muted-foreground text-xs">
            <span>
              {t('settings.import.selectedOf', {
                total: candidates.length,
                selected: selected.length,
              })}
            </span>
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setSelected(selectAll(candidates))}>
                {t('common.selectAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(invertSelection(candidates, selected))}
              >
                {t('common.invertSelection')}
              </Button>
            </span>
          </div>
          <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                checked={selected.includes(candidate.id)}
                onCheckedChange={(on) =>
                  setSelected((current) =>
                    on ? [...current, candidate.id] : current.filter((id) => id !== candidate.id)
                  )
                }
              />
            ))}
          </ul>
        </div>
      )}

      {scan.phase === 'done' && <WarningList warnings={scan.warnings} />}

      {importError && <InlineMessage tone="error">{importError}</InlineMessage>}

      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={importing} />}>
          {t('common.cancel')}
        </DialogClose>
        <Button
          disabled={!ready || selected.length === 0 || importing}
          onClick={() => void runImport()}
        >
          {importing
            ? t('settings.import.importing')
            : t('settings.import.importPicked', { count: selected.length })}
        </Button>
      </DialogFooter>
    </div>
  );
}

function CandidateRow({
  candidate,
  checked,
  onCheckedChange,
}: {
  candidate: ProviderImportCandidate;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const reason = duplicateReason(candidate);
  const id = useId();
  const t = useT();
  return (
    <li>
      {/* 整行都是标签：点哪里都能勾选；Checkbox 的 onClick 会 preventDefault，不会被标签再触发一次 */}
      <label
        htmlFor={id}
        className={cn(
          'flex items-start gap-3 px-3 py-2',
          reason ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-accent/50'
        )}
      >
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={checked}
          disabled={reason !== null}
          onCheckedChange={onCheckedChange}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{candidate.name}</span>
            <Badge variant="outline" title={candidate.sourceLabel}>
              {sourceLabel(candidate.source)}
            </Badge>
            <Badge variant="outline">{providerApiLabel(candidate.api)}</Badge>
            {candidate.isCurrent && <Badge>{t('settings.providers.current')}</Badge>}
            {reason && <Badge title={reason}>{duplicateBadge(candidate)}</Badge>}
          </div>
          <p className="truncate text-muted-foreground text-xs">
            <span className="font-mono">
              {maskSecrets(resolveBaseUrl(candidate.api, candidate.baseUrl))}
            </span>
            {' · '}
            {candidate.hasApiKey ? (
              <span className="font-mono">••••{candidate.apiKeyHint ?? ''}</span>
            ) : (
              <span className="text-destructive">{t('settings.providers.noKey')}</span>
            )}
          </p>
          <p className="truncate text-muted-foreground text-xs">{modelSummary(candidate)}</p>
        </div>
      </label>
    </li>
  );
}
