import type { PluginImportCandidateView } from '@shared/types/plugins';
import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { usePluginsStore } from '@/stores/plugins';
import type { T } from '../../i18n';
import { InlineMessage, WarningList } from './common';

export type PluginImportStatus = { tone: 'success' | 'error'; text: string };

/** 从本机导入原生 pi 的扩展与包。每次打开（session 变化）重新扫描；只把候选 id 交给 Main。 */
export function PluginImportDialog({
  session,
  onClose,
  onImported,
}: {
  /** 打开时是本次导入的序号，关闭时为 null */
  session: number | null;
  onClose: () => void;
  onImported: (status: PluginImportStatus) => void;
}) {
  // 关闭动画期间沿用上一次的内容，避免弹窗闪成空白
  const [shown, setShown] = useState(session);
  if (session !== null && session !== shown) setShown(session);

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {shown !== null && (
          <ImportContent
            key={shown}
            onImported={(status) => {
              onImported(status);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type ScanState =
  | { phase: 'scanning' }
  | { phase: 'done'; candidates: PluginImportCandidateView[]; warnings: string[] }
  | { phase: 'failed'; error: string };

const selectable = (candidates: readonly PluginImportCandidateView[]) =>
  candidates.filter((candidate) => !candidate.duplicateOf).map((candidate) => candidate.id);

function ImportContent({ onImported }: { onImported: (status: PluginImportStatus) => void }) {
  const scanImports = usePluginsStore((state) => state.scanImports);
  const importCandidates = usePluginsStore((state) => state.importCandidates);
  // 「重新扫描」加一：effect 依赖变了就再扫一次
  const [round, setRound] = useState(0);
  const [scan, setScan] = useState<ScanState>({ phase: 'scanning' });
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const t = useT();

  // 只认最后一次扫描的返回；Main 缓存的也正是这一次的候选
  useEffect(() => {
    void round;
    let active = true;
    setScan({ phase: 'scanning' });
    setImportError(null);
    void scanImports().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setScan({ phase: 'failed', error: result.error });
        return;
      }
      setScan({ phase: 'done', candidates: result.candidates, warnings: result.warnings });
      setSelected(selectable(result.candidates));
    });
    return () => {
      active = false;
    };
  }, [scanImports, round]);

  const candidates = scan.phase === 'done' ? scan.candidates : [];
  const needsTools = candidates.some((candidate) => candidate.kind !== 'local');

  const runImport = async () => {
    setImporting(true);
    setImportError(null);
    // 按列表顺序提交，丢掉已不在列表里的 id
    const ids = candidates
      .filter((candidate) => selected.includes(candidate.id))
      .map((candidate) => candidate.id);
    const result = await importCandidates(ids);
    setImporting(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    onImported({
      tone: result.imported.length > 0 ? 'success' : 'error',
      text: importSummary(result, t),
    });
  };

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{t('settings.plugins.importTitle')}</DialogTitle>
      </DialogHeader>

      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={scan.phase === 'scanning' || importing}
          onClick={() => setRound((n) => n + 1)}
        >
          <RefreshCw />
          {t('settings.import.rescan')}
        </Button>
      </div>

      {scan.phase === 'scanning' ? (
        <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.import.scanning')}
        </p>
      ) : scan.phase === 'failed' ? (
        <InlineMessage tone="error">{scan.error}</InlineMessage>
      ) : candidates.length === 0 ? (
        <p className="py-6 text-center text-sm">{t('settings.plugins.importNone')}</p>
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
              <Button variant="ghost" size="sm" onClick={() => setSelected(selectable(candidates))}>
                {t('common.selectAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(selectable(candidates).filter((id) => !selected.includes(id)))
                }
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
          {needsTools && (
            <p className="text-muted-foreground text-xs">
              {t('settings.plugins.importNeedsTools')}
            </p>
          )}
        </div>
      )}

      {scan.phase === 'done' && <WarningList warnings={scan.warnings} />}

      {importError && <InlineMessage tone="error">{importError}</InlineMessage>}

      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{t('common.cancel')}</DialogClose>
        <Button
          disabled={scan.phase !== 'done' || selected.length === 0 || importing}
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
  candidate: PluginImportCandidateView;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const duplicate = candidate.duplicateOf !== undefined;
  const id = useId();
  const t = useT();
  return (
    <li>
      {/* 整行都是标签：点哪里都能勾选；Checkbox 的 onClick 会 preventDefault，不会被标签再触发一次 */}
      <label
        htmlFor={id}
        className={cn(
          'flex items-start gap-3 px-3 py-2',
          duplicate ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-accent/50'
        )}
      >
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={!duplicate && checked}
          disabled={duplicate}
          onCheckedChange={onCheckedChange}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{candidate.name}</span>
            <Badge variant="outline">{kindLabel(candidate, t)}</Badge>
            {duplicate && (
              <Badge
                title={t('settings.plugins.importDuplicateOf', {
                  name: candidate.duplicateOf ?? '',
                })}
              >
                {t('settings.plugins.importRegistered')}
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-muted-foreground text-xs" title={candidate.display}>
            {candidate.display}
          </p>
        </div>
      </label>
    </li>
  );
}

function kindLabel(candidate: PluginImportCandidateView, t: T): string {
  if (candidate.kind === 'local') {
    return t(
      candidate.form === 'file'
        ? 'settings.plugins.importForms.file'
        : 'settings.plugins.importForms.dir'
    );
  }
  return t(`settings.plugins.kinds.${candidate.kind}`);
}

/** 「已导入 N 个插件」，有失败的再逐条列出「名称（原因）」 */
function importSummary(
  result: { imported: readonly string[]; failed: ReadonlyArray<{ name: string; error: string }> },
  t: T
): string {
  const done = t('settings.plugins.imported', { count: result.imported.length });
  if (result.failed.length === 0) return done;
  const items = result.failed
    .map((item) => t('settings.import.skippedItem', { name: item.name, reason: item.error }))
    .join(t('settings.import.itemSeparator'));
  return t('settings.plugins.importFailedItems', { done, count: result.failed.length, items });
}
