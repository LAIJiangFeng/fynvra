import {
  ChevronRight,
  CircleAlert,
  File,
  Folder,
  FolderOpen,
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
import { useT } from '@/i18n/I18nProvider';
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
import { buildFileTree, type FileTreeNode } from './fileTree';
import { formatRelative, oneLine, shortSha, taskStatusLabel } from './format';
import { useSeenOnce } from './hooks';

/** 默认展开的文件：单个不超过这么多行，且累计不超过 {@link OPEN_BUDGET}。 */
const OPEN_FILE_LINES = 400;
const OPEN_BUDGET = 1_500;
/** 一个文件每次多渲染这么多行。 */
const LINE_CHUNK = 400;
const LINE_HEIGHT_PX = 18;

/** 状态字母与配色；读屏与悬停的名称在字典 orchestration.fileStatus */
const STATUS_MARK: Record<DiffFileStatus, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { letter: 'D', className: 'text-red-600 dark:text-red-400' },
  modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400' },
  renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400' },
  copied: { letter: 'C', className: 'text-sky-600 dark:text-sky-400' },
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
  const t = useT();
  if (candidates.length === 0) {
    return <PanelMessage icon={GitCompareArrows} title={t('orchestration.noChanges')} />;
  }
  const selected =
    candidates.find((candidate) => candidate.dispatch.id === selectedId) ?? candidates[0];
  if (!selected) return null;
  const items = candidates.map(({ task, dispatch }) => ({
    value: dispatch.id,
    label: t('orchestration.candidate', {
      status: taskStatusLabel(task.status, t),
      title: oneLine(task.title, 48),
    }),
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
        <SelectTrigger size="sm" className="text-xs" aria-label={t('orchestration.pickAttempt')}>
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
        <PanelMessage icon={GitCompareArrows} title={t('common.noGit')} />
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
  const t = useT();

  useEffect(() => {
    // 已合并的改动从主仓库里的固定提交读取，不以 worktree 是否还在决定能否加载。
    void loadDiff(dispatchId);
  }, [dispatchId, loadDiff]);
  if (!entry || entry.status === 'loading') {
    return <PanelMessage icon={Loader2} spin title={t('orchestration.loadingDiff')} />;
  }
  if (entry.status === 'error') {
    return (
      <PanelMessage
        icon={CircleAlert}
        title={t('orchestration.diffFailed')}
        description={entry.error}
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => void loadDiff(dispatchId, { force: true })}
        >
          <RefreshCw />
          {t('common.retry')}
        </Button>
      </PanelMessage>
    );
  }
  return (
    <DiffContent
      data={entry.data}
      refreshing={entry.refreshing}
      stale={!worktreeAlive}
      onRefresh={() => void loadDiff(dispatchId, { force: true })}
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
  const summary = statSummary(data.stat);
  const t = useT();

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
              aria-label={t('orchestration.reloadDiff')}
              title={t('orchestration.reloadDiff')}
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
            {t('orchestration.base')} <span className="font-mono">{shortSha(data.baseCommit)}</span>
          </span>
          {summary && (
            <span className="min-w-0 truncate" title={summary}>
              · {summary}
            </span>
          )}
        </p>
        {stale && (
          <p className="mt-1 text-amber-700 dark:text-amber-300">{t('orchestration.staleDiff')}</p>
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

      {data.uncommitted.available ? (
        <ChangeSet
          title={t('orchestration.uncommittedChanges')}
          files={data.uncommitted.files}
          diff={data.uncommitted.diff}
          empty={t('orchestration.noUncommitted')}
        />
      ) : (
        <SectionBox title={t('orchestration.uncommittedChanges')}>
          <SectionNote>{t('orchestration.worktreeRemoved')}</SectionNote>
        </SectionBox>
      )}
      <ChangeSet
        title={t('orchestration.committedChanges')}
        files={data.files}
        diff={data.diff}
        empty={t('orchestration.noCommits')}
      />
      <SectionBox title={t('orchestration.commitsSection')} count={data.commits.length}>
        {data.commits.length === 0 ? (
          <SectionNote>{t('orchestration.noCommitList')}</SectionNote>
        ) : (
          <CommitList commits={data.commits} />
        )}
      </SectionBox>
    </div>
  );
}

/** 一个可折叠分区：标题 + 数量，默认展开。 */
function SectionBox({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded py-0.5 text-left font-semibold text-[11px] text-muted-foreground uppercase tracking-wide outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono font-normal tabular-nums">
              {count}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1.5 flex flex-col gap-2">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function SectionNote({ children }: { children: ReactNode }) {
  return <p className="py-3 text-center text-muted-foreground text-xs">{children}</p>;
}

/** 一组改动（未提交 / 已提交）：目录树 + 下面逐文件的 diff，点树里的文件展开并滚到它的 diff。 */
function ChangeSet({
  title,
  files: names,
  diff,
  empty,
}: {
  title: string;
  files: string[];
  diff: string;
  empty: string;
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  // `files` 里有、patch 里没有文本 diff 的条目（理论上不会出现，防御一下）
  const extra = useMemo(() => {
    const parsed = new Set(files.flatMap((file) => [file.path, file.oldPath ?? file.path]));
    return names.filter((path) => !parsed.has(path));
  }, [names, files]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => defaultOpenFiles(files));
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const t = useT();

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
    <SectionBox title={title} count={files.length + extra.length}>
      {files.length === 0 && extra.length === 0 ? (
        <SectionNote>{empty}</SectionNote>
      ) : (
        <>
          {files.length > 0 && <FileTree nodes={tree} onReveal={reveal} />}
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
              {path}{' '}
              <span className="font-sans text-muted-foreground">
                {t('orchestration.noTextDiff')}
              </span>
            </p>
          ))}
        </>
      )}
    </SectionBox>
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

const TREE_INDENT_PX = 12;

/** VS Code 式目录树：目录行折叠 / 展开，文件行点击展开并滚到它的 diff。 */
function FileTree({ nodes, onReveal }: { nodes: FileTreeNode[]; onReveal: (key: string) => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const t = useT();
  const toggleFolder = (path: string) =>
    setCollapsed((current) => {
      const updated = new Set(current);
      if (updated.has(path)) updated.delete(path);
      else updated.add(path);
      return updated;
    });

  const rows: ReactNode[] = [];
  const walk = (list: FileTreeNode[], depth: number) => {
    for (const node of list) {
      const indent = 6 + depth * TREE_INDENT_PX;
      if (node.kind === 'folder') {
        const isOpen = !collapsed.has(node.path);
        const Icon = isOpen ? FolderOpen : Folder;
        rows.push(
          <li key={`d:${node.path}`}>
            <button
              type="button"
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[11px] outline-none hover:bg-accent focus-visible:bg-accent"
              style={{ paddingLeft: indent }}
              title={node.path}
              onClick={() => toggleFolder(node.path)}
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', isOpen && 'rotate-90')}
              />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-muted-foreground tabular-nums"
                title={t('orchestration.folderFiles', { count: node.fileCount })}
              >
                {node.fileCount}
              </span>
            </button>
          </li>
        );
        if (isOpen) walk(node.children, depth + 1);
        continue;
      }
      const { file } = node;
      const mark = STATUS_MARK[file.status];
      const key = fileKey(file);
      rows.push(
        <li key={`f:${key}`}>
          <button
            type="button"
            className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[11px] outline-none hover:bg-accent focus-visible:bg-accent"
            // 与目录行的 chevron（size-3 + gap）对齐
            style={{ paddingLeft: indent + 16 }}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            onClick={() => onReveal(key)}
          >
            <File className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono',
                file.status === 'deleted' && 'line-through'
              )}
            >
              {node.name}
            </span>
            <LineCounts file={file} />
            <span
              className={cn('w-3 shrink-0 text-center font-mono font-semibold', mark.className)}
            >
              <span aria-hidden>{mark.letter}</span>
              <span className="sr-only">{t(`orchestration.fileStatus.${file.status}`)}</span>
            </span>
          </button>
        </li>
      );
    }
  };
  walk(nodes, 0);

  return (
    <ul
      className="flex flex-col rounded-md border py-1"
      aria-label={t('orchestration.changedFiles')}
    >
      {rows}
    </ul>
  );
}

/** 提交列表：新的在前。 */
function CommitList({ commits }: { commits: ReviewDiffData['commits'] }) {
  const t = useT();
  const now = Date.now();
  return (
    <ul className="flex flex-col rounded-md border py-1">
      {commits.map((commit) => {
        const epoch = Date.parse(commit.date);
        return (
          <li
            key={commit.sha}
            className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 text-[11px]"
            title={`${commit.sha}\n${commit.author} · ${commit.date}\n\n${commit.subject}`}
          >
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-muted-foreground">{shortSha(commit.sha)}</span>
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
            <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
              {commit.author} · {Number.isNaN(epoch) ? commit.date : formatRelative(epoch, now, t)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function LineCounts({ file }: { file: DiffFile }) {
  const t = useT();
  if (file.binary) {
    return <span className="shrink-0 text-muted-foreground">{t('orchestration.binary')}</span>;
  }
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
  const t = useT();
  return (
    <section ref={sectionRef} aria-label={file.path} className="scroll-mt-2 rounded-md border">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="group sticky top-0 z-[1] flex w-full items-center gap-1.5 rounded-t-md bg-card px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[panel-open]:border-b">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
          <span
            className={cn('shrink-0 font-mono font-semibold', mark.className)}
            title={t(`orchestration.fileStatus.${file.status}`)}
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
  const t = useT();

  if (file.binary) {
    return (
      <p className="px-3 py-2 text-muted-foreground text-xs">{t('orchestration.binaryFile')}</p>
    );
  }
  if (total === 0) {
    const detail =
      file.meta.length > 0
        ? file.meta.join(' · ')
        : file.status === 'renamed'
          ? t('orchestration.renameOnly')
          : t('orchestration.noTextChanges');
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
            {t('orchestration.showMore', { count: Math.min(LINE_CHUNK, rest), rest })}
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
