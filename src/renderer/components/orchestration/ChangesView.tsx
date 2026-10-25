import {
  ChevronRight,
  CircleAlert,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrchestrationSnapshotView } from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import {
  type ReviewCandidate,
  type ReviewDiffData,
  useOrchestrationStore,
} from '@/stores/orchestration';
import { PanelMessage } from './common';
import {
  type DiffFile,
  type DiffFileStatus,
  type DiffLine,
  diffLineCount,
  parseUnifiedDiff,
  statSummary,
} from './diff';
import { oneLine, shortSha, TASK_STATUS_LABEL } from './format';
import { useSeenOnce } from './hooks';

/** 默认展开的文件：单个不超过这么多行，且累计不超过 {@link OPEN_BUDGET}。 */
const OPEN_FILE_LINES = 400;
const OPEN_BUDGET = 1_500;
/** 一个文件每次多渲染这么多行。 */
const LINE_CHUNK = 400;
const LINE_HEIGHT_PX = 18;

const STATUS_MARK: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400', label: '新增' },
  deleted: { letter: 'D', className: 'text-red-600 dark:text-red-400', label: '删除' },
  modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400', label: '修改' },
  renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400', label: '重命名' },
  copied: { letter: 'C', className: 'text-sky-600 dark:text-sky-400', label: '复制' },
};

/** 「改动」tab：选一个待验收 / 已完成任务的当前尝试，看它的 diff。 */
export function ChangesView({
  view,
  candidates,
  selectedId,
  onSelect,
}: {
  view: OrchestrationSnapshotView;
  candidates: ReviewCandidate[];
  selectedId: string | null;
  onSelect: (dispatchId: string) => void;
}) {
  if (candidates.length === 0) {
    return <PanelMessage icon={GitCompareArrows} title="还没有待验收或已完成的改动" />;
  }
  const selected =
    candidates.find((candidate) => candidate.dispatch.id === selectedId) ?? candidates[0];
  if (!selected) return null;
  const items = candidates.map(({ task, dispatch }) => ({
    value: dispatch.id,
    label: `[${TASK_STATUS_LABEL[task.status]}] ${oneLine(task.title, 48)}`,
  }));
  const worktreeAlive = view.worktrees.some(
    (worktree) => worktree.id === selected.dispatch.worktreeId
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <Select
        items={items}
        value={selected.dispatch.id}
        onValueChange={(value) => {
          if (typeof value === 'string') onSelect(value);
        }}
      >
        <SelectTrigger size="sm" className="text-xs" aria-label="选择要查看的尝试">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="text-xs">
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected.dispatch.mode === 'in-place' ? (
        <PanelMessage icon={GitCompareArrows} title="无 git" />
      ) : (
        <DispatchDiff
          key={selected.dispatch.id}
          dispatchId={selected.dispatch.id}
          worktreeAlive={worktreeAlive}
        />
      )}
    </div>
  );
}

function DispatchDiff({
  dispatchId,
  worktreeAlive,
}: {
  dispatchId: string;
  worktreeAlive: boolean;
}) {
  const entry = useOrchestrationStore((state) => state.diffs[dispatchId]);
  const loadDiff = useOrchestrationStore((state) => state.loadDiff);

  useEffect(() => {
    if (worktreeAlive) void loadDiff(dispatchId);
  }, [dispatchId, worktreeAlive, loadDiff]);

  if (!worktreeAlive && entry?.status !== 'ready') {
    return <PanelMessage icon={GitCompareArrows} title="worktree 已清理" />;
  }
  if (!entry || entry.status === 'loading') {
    return <PanelMessage icon={Loader2} spin title="正在读取改动…" />;
  }
  if (entry.status === 'error') {
    return (
      <PanelMessage icon={CircleAlert} title="读取改动失败" description={entry.error}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void loadDiff(dispatchId, { force: true })}
        >
          <RefreshCw />
          重试
        </Button>
      </PanelMessage>
    );
  }
  return (
    <DiffContent
      data={entry.data}
      refreshing={entry.refreshing}
      stale={!worktreeAlive}
      onRefresh={worktreeAlive ? () => void loadDiff(dispatchId, { force: true }) : undefined}
    />
  );
}

function DiffContent({
  data,
  refreshing,
  stale,
  onRefresh,
}: {
  data: ReviewDiffData;
  refreshing: boolean;
  stale: boolean;
  onRefresh: (() => void) | undefined;
}) {
  const files = useMemo(() => parseUnifiedDiff(data.diff), [data]);
  // `files` 里有、patch 里没有文本 diff 的条目（理论上不会出现，防御一下）
  const extra = useMemo(() => {
    const parsed = new Set(files.flatMap((file) => [file.path, file.oldPath ?? file.path]));
    return data.files.filter((path) => !parsed.has(path));
  }, [data, files]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => defaultOpenFiles(files));
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const summary = statSummary(data.stat);

  const toggle = (key: string, next: boolean) =>
    setOpen((current) => {
      const updated = new Set(current);
      if (next) updated.add(key);
      else updated.delete(key);
      return updated;
    });

  const reveal = (key: string) => {
    toggle(key, true);
    requestAnimationFrame(() =>
      sectionRefs.current.get(key)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border bg-card px-2.5 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono">{data.branch}</span>
          {onRefresh && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="重新读取改动"
              title="重新读取改动"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
          )}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <GitCommitHorizontal className="size-3.5 shrink-0" />
          <span className="shrink-0">
            相对 <span className="font-mono">{shortSha(data.baseCommit)}</span>
          </span>
          {summary && (
            <span className="min-w-0 truncate" title={summary}>
              · {summary}
            </span>
          )}
        </p>
        {stale && (
          <p className="mt-1 text-amber-700 dark:text-amber-300">
            worktree 已清理，这是清理前的改动
          </p>
        )}
        {data.stat && (
          <Collapsible className="mt-1.5">
            <CollapsibleTrigger className="group flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
              git diff --stat
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] leading-snug">
                {data.stat}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {files.length === 0 && extra.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-xs">还没有提交的改动</p>
      ) : (
        <>
          <FileList files={files} onReveal={reveal} />
          <div className="flex flex-col gap-2">
            {files.map((file) => {
              const key = fileKey(file);
              return (
                <DiffFileSection
                  key={key}
                  file={file}
                  open={open.has(key)}
                  onOpenChange={(next) => toggle(key, next)}
                  sectionRef={(element) => {
                    if (element) sectionRefs.current.set(key, element);
                    else sectionRefs.current.delete(key);
                  }}
                />
              );
            })}
            {extra.map((path) => (
              <p key={path} className="rounded-md border px-2 py-1.5 font-mono text-[11px]">
                {path} <span className="font-sans text-muted-foreground">（没有文本 diff）</span>
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 同一路径可能出现两次（类型变更 = 删除 + 新增），按状态 + 路径区分。 */
function fileKey(file: DiffFile): string {
  return `${file.status}:${file.oldPath ?? ''}:${file.path}`;
}

function defaultOpenFiles(files: DiffFile[]): Set<string> {
  const open = new Set<string>();
  let budget = OPEN_BUDGET;
  for (const file of files) {
    const lines = diffLineCount(file);
    if (lines === 0 || lines > OPEN_FILE_LINES || lines > budget) continue;
    open.add(fileKey(file));
    budget -= lines;
  }
  return open;
}

function FileList({ files, onReveal }: { files: DiffFile[]; onReveal: (key: string) => void }) {
  return (
    <ul className="flex flex-col rounded-md border py-1" aria-label="改动文件">
      {files.map((file) => {
        const mark = STATUS_MARK[file.status];
        return (
          <li key={fileKey(file)}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-0.5 text-left text-[11px] outline-none hover:bg-accent focus-visible:bg-accent"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => onReveal(fileKey(file))}
            >
              <span className={cn('w-3 shrink-0 font-mono font-semibold', mark.className)}>
                <span aria-hidden>{mark.letter}</span>
                <span className="sr-only">{mark.label}</span>
              </span>
              <span className="min-w-0 flex-1 truncate font-mono" dir="rtl">
                <bdi>{file.path}</bdi>
              </span>
              <LineCounts file={file} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function LineCounts({ file }: { file: DiffFile }) {
  if (file.binary) return <span className="shrink-0 text-muted-foreground">二进制</span>;
  return (
    <span className="shrink-0 font-mono tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
      <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
    </span>
  );
}

function DiffFileSection({
  file,
  open,
  onOpenChange,
  sectionRef,
}: {
  file: DiffFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sectionRef: (element: HTMLElement | null) => void;
}) {
  const mark = STATUS_MARK[file.status];
  return (
    <section ref={sectionRef} aria-label={file.path} className="scroll-mt-2 rounded-md border">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="group sticky top-0 z-[1] flex w-full items-center gap-1.5 rounded-t-md bg-card px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[panel-open]:border-b">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
          <span
            className={cn('shrink-0 font-mono font-semibold', mark.className)}
            title={mark.label}
          >
            {mark.letter}
          </span>
          <span className="min-w-0 flex-1 break-words font-mono text-[11px]">
            {file.oldPath && (
              <span className="text-muted-foreground">
                <PathText path={file.oldPath} />
                {' → '}
              </span>
            )}
            <PathText path={file.path} />
          </span>
          <LineCounts file={file} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <LazyDiffBody file={file} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** 路径只在 `/` 之后换行，窄面板里不会把文件名拦腰截断。 */
function PathText({ path }: { path: string }) {
  return path.split('/').map((segment, index, segments) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 路径段的位置就是它的身份
    <span key={index}>
      {segment}
      {index < segments.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </span>
  ));
}

/** 展开后、接近视口时才渲染行；超长文件每次多显示 {@link LINE_CHUNK} 行。 */
function LazyDiffBody({ file }: { file: DiffFile }) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(placeholderRef);
  const [limit, setLimit] = useState(LINE_CHUNK);
  const total = diffLineCount(file);

  if (file.binary) {
    return <p className="px-3 py-2 text-muted-foreground text-xs">二进制文件，不显示内容</p>;
  }
  if (total === 0) {
    const detail =
      file.meta.length > 0
        ? file.meta.join(' · ')
        : file.status === 'renamed'
          ? '仅重命名，内容没有变化'
          : '没有文本改动';
    return <p className="px-3 py-2 text-muted-foreground text-xs">{detail}</p>;
  }
  if (!seen) {
    return (
      <div
        ref={placeholderRef}
        aria-hidden
        style={{ height: Math.min(total, LINE_CHUNK) * LINE_HEIGHT_PX }}
      />
    );
  }
  const rest = total - limit;
  return (
    <div>
      {file.meta.length > 0 && (
        <p className="border-b px-3 py-1 font-mono text-[11px] text-muted-foreground">
          {file.meta.join(' · ')}
        </p>
      )}
      <DiffLines file={file} limit={limit} />
      {rest > 0 && (
        <div className="border-t px-2 py-1.5 text-center">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setLimit((current) => current + LINE_CHUNK)}
          >
            再显示 {Math.min(LINE_CHUNK, rest)} 行（还有 {rest} 行）
          </Button>
        </div>
      )}
    </div>
  );
}

const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10 dark:bg-emerald-400/10',
  del: 'bg-red-500/10 dark:bg-red-400/10',
  context: '',
  note: 'text-muted-foreground italic',
};
const MARKER: Record<DiffLine['kind'], { text: string; className: string }> = {
  add: { text: '+', className: 'text-emerald-700 dark:text-emerald-300' },
  del: { text: '-', className: 'text-red-700 dark:text-red-300' },
  context: { text: ' ', className: '' },
  note: { text: '', className: '' },
};

const DiffLines = memo(function DiffLines({ file, limit }: { file: DiffFile; limit: number }) {
  const lastHunk = file.hunks.at(-1);
  const maxLine = lastHunk
    ? Math.max(lastHunk.oldStart + lastHunk.oldLines, lastHunk.newStart + lastHunk.newLines)
    : 1;
  const gutter = { width: `calc(${String(maxLine).length}ch + 0.75rem)` };
  const rows: ReactNode[] = [];
  let count = 0;
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    if (count >= limit) break;
    rows.push(
      <div
        key={`h${hunkIndex}`}
        className="truncate bg-sky-500/10 px-2 text-sky-800 dark:text-sky-300"
        title={hunk.header}
      >
        {hunk.header}
      </div>
    );
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (count >= limit) break;
      count += 1;
      const marker = MARKER[line.kind];
      rows.push(
        <div key={`${hunkIndex}:${lineIndex}`} className={cn('flex', ROW_TONE[line.kind])}>
          <span
            className="shrink-0 select-none pr-1 text-right text-muted-foreground/70"
            style={gutter}
          >
            {line.oldLine}
          </span>
          <span
            className="shrink-0 select-none border-r pr-1 text-right text-muted-foreground/70"
            style={gutter}
          >
            {line.newLine}
          </span>
          <span className={cn('w-4 shrink-0 select-none text-center', marker.className)}>
            {marker.text}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
            {line.text === '' ? ' ' : line.text}
          </span>
        </div>
      );
    }
  }
  return <div className="font-mono text-[11px] leading-[18px]">{rows}</div>;
});
