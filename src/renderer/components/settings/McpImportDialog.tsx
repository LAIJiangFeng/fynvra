import type { McpImportCandidate, McpImportSource } from '@shared/types/llm';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
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
import { useMcpStore } from '@/stores/mcp';
import { InlineMessage, WarningList } from './common';
import {
  commandSummary,
  defaultSelection,
  duplicateBadge,
  duplicateReason,
  importSummary,
  invertSelection,
  MCP_IMPORT_SOURCES,
  mcpSourceLabel,
  mcpSourcePath,
  orderedSelection,
  selectAll,
  toggleMcpSource,
} from './mcpImport';
import { maskSecrets } from './secretMask';

export type McpImportStatus = { tone: 'success' | 'error'; text: string };

/** 从本机 8 个工具导入 MCP 服务器。每次打开（session 变化）重新扫描。 */
export function McpImportDialog({
  session,
  onClose,
  onImported,
}: {
  /** 打开时是本次导入的序号，关闭时为 null */
  session: number | null;
  onClose: () => void;
  onImported: (status: McpImportStatus) => void;
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
  | { phase: 'done'; candidates: McpImportCandidate[]; warnings: string[] }
  | { phase: 'failed'; error: string };

function ImportContent({ onImported }: { onImported: (status: McpImportStatus) => void }) {
  const scanImports = useMcpStore((state) => state.scanImports);
  const importCandidates = useMcpStore((state) => state.importCandidates);
  const idPrefix = useId();
  // 「重新扫描」放回一个新数组：引用变了，下面的 effect 就会再扫一次
  const [sources, setSources] = useState<McpImportSource[]>(() =>
    MCP_IMPORT_SOURCES.map((source) => source.id)
  );
  const [scan, setScan] = useState<ScanState>({ phase: 'scanning' });
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const t = useT();

  // 只认最后一次扫描的返回；Main 也按顺序扫，它缓存的正是这一次的结果。
  // 切换来源会重新扫描：重复关系取决于扫了哪些来源，只在已有结果里过滤会留下指向隐藏候选的「重复」
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
    setImportError(null);
    const result = await importCandidates(orderedSelection(candidates, selected));
    setImporting(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    onImported({
      tone: result.imported.length > 0 ? 'success' : 'error',
      text: importSummary(result),
    });
  };

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{t('settings.mcp.importTitle')}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {MCP_IMPORT_SOURCES.map((source) => (
          <label
            key={source.id}
            htmlFor={`${idPrefix}-${source.id}`}
            className="flex cursor-pointer items-center gap-2 text-sm"
            title={mcpSourcePath(source, t)}
          >
            <Checkbox
              id={`${idPrefix}-${source.id}`}
              checked={sources.includes(source.id)}
              onCheckedChange={(on) =>
                setSources((current) => toggleMcpSource(current, source.id, on))
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
        <p className="py-6 text-center text-sm">{t('settings.mcp.importNone')}</p>
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
        <DialogClose render={<Button variant="outline" />}>{t('common.cancel')}</DialogClose>
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
  candidate: McpImportCandidate;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const reason = duplicateReason(candidate);
  const summary = maskSecrets(commandSummary(candidate));
  const secretKeys = [...candidate.envKeys, ...candidate.headerKeys];
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
              {mcpSourceLabel(candidate.source)}
            </Badge>
            <Badge variant="outline">{t(`settings.mcp.transports.${candidate.transport}`)}</Badge>
            {candidate.enabledInSource && <Badge>{t('settings.mcp.enabledInSource')}</Badge>}
            {reason && <Badge title={reason}>{duplicateBadge(candidate)}</Badge>}
          </div>
          <p className="truncate font-mono text-muted-foreground text-xs" title={summary}>
            {summary}
          </p>
          {secretKeys.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {secretKeys.map((key) => (
                <Badge
                  key={key}
                  variant="outline"
                  className="font-mono"
                  title={t('settings.import.keyLocalOnly')}
                >
                  <KeyRound />
                  {key}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </label>
    </li>
  );
}
