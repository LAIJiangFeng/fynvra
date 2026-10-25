import { providerApiLabel, resolveBaseUrl } from '@shared/modelCatalog';
import type { ProviderImportCandidate, ProviderImportSource } from '@shared/types/llm';
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
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers';
import { InlineMessage, WarningList } from './common';
import {
  defaultSelection,
  duplicateBadge,
  duplicateReason,
  IMPORT_SOURCES,
  importSummary,
  invertSelection,
  modelSummary,
  orderedSelection,
  selectAll,
  sourceLabel,
  toggleSource,
} from './providerImport';
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
  | { phase: 'done'; candidates: ProviderImportCandidate[]; warnings: string[] }
  | { phase: 'failed'; error: string };

function ImportContent({ onImported }: { onImported: (status: ImportStatus) => void }) {
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
        <DialogTitle>从本机导入模型服务</DialogTitle>
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
          重新扫描
        </Button>
      </div>

      {sources.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">至少选择一个来源</p>
      ) : scan.phase === 'scanning' ? (
        <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          正在扫描本机配置…
        </p>
      ) : scan.phase === 'failed' ? (
        <InlineMessage tone="error">{scan.error}</InlineMessage>
      ) : candidates.length === 0 ? (
        <p className="py-6 text-center text-sm">没有找到带 API Key 或自定义地址的配置</p>
      ) : (
        <div className="grid min-w-0 gap-2">
          <div className="flex items-center justify-between text-muted-foreground text-xs">
            <span>
              共 {candidates.length} 个，已选 {selected.length}
            </span>
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setSelected(selectAll(candidates))}>
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(invertSelection(candidates, selected))}
              >
                反选
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
        <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
        <Button
          disabled={!ready || selected.length === 0 || importing}
          onClick={() => void runImport()}
        >
          {importing ? '导入中…' : `导入所选（${selected.length}）`}
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
            {candidate.isCurrent && <Badge>当前使用</Badge>}
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
              <span className="text-destructive">没有 API Key</span>
            )}
          </p>
          <p className="truncate text-muted-foreground text-xs">{modelSummary(candidate)}</p>
        </div>
      </label>
    </li>
  );
}
