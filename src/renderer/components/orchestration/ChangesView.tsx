import type { SessionChanges } from '@shared/types/orchestration';
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
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import {
  type DiffSection,
  type DiffSource,
  diffSourceKey,
  diffTabsStoreFor,
} from '@/stores/diffTabs';
import type { ReviewDiffData } from '@/stores/orchestration';
import { loadSourceDiff, useSourceDiff } from '@/stores/sessionChanges';
import { useSessionsStore } from '@/stores/sessions';
import { statusOf } from '@/stores/sessions/selectors';
import { PanelMessage } from './common';
import { type DiffFile, parseUnifiedDiff, statSummary } from './diff';
import { LineCounts, STATUS_MARK } from './diffView';
import { buildFileTree, type FileTreeNode } from './fileTree';
import { formatRelative, shortSha } from './format';

/** Current conversation by default; historical task review has an explicit, separate source. */
export function ChangesView({ source }: { source: DiffSource }) {
  const entry = useSourceDiff(source);
  const t = useT();

  useEffect(() => {
    void loadSourceDiff(source, true);
    const refresh = () => void loadSourceDiff(source, true);
    window.addEventListener('focus', refresh);
    const unsubscribe = useSessionsStore.subscribe((state, previous) => {
      if (source.kind !== 'session' || !source.sessionId) return;
      const status = statusOf(state, source.sessionId);
      if (
        status !== statusOf(previous, source.sessionId) &&
        (status === 'idle' || status === 'error')
      )
        refresh();
    });
    return () => {
      window.removeEventListener('focus', refresh);
      unsubscribe();
    };
  }, [source]);
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
        <Button size="sm" variant="outline" onClick={() => void loadSourceDiff(source, true)}>
          <RefreshCw />
          {t('common.retry')}
        </Button>
      </PanelMessage>
    );
  }
  if ('availability' in entry.data && entry.data.availability !== 'available') {
    return (
      <PanelMessage
        icon={GitCompareArrows}
        title={t(
          entry.data.availability === 'no-git'
            ? 'common.noGit'
            : 'orchestration.currentWorktreeRemoved'
        )}
      />
    );
  }
  return (
    <div className="p-3">
      <DiffContent
        source={source}
        data={entry.data}
        refreshing={entry.refreshing}
        onRefresh={() => void loadSourceDiff(source, true)}
      />
    </div>
  );
}

function DiffContent({
  source,
  data,
  refreshing,
  onRefresh,
}: {
  source: DiffSource;
  data: ReviewDiffData | SessionChanges;
  refreshing: boolean;
  onRefresh: (() => void) | undefined;
}) {
  const summary = statSummary(data.stat);
  const t = useT();

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border bg-card px-2.5 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {data.branch || t('orchestration.detachedHead')}
            {'headCommit' in data && data.headCommit && ` · ${shortSha(data.headCommit)}`}
          </span>
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
        {'comparison' in data && (
          <p className="mt-1 text-muted-foreground">
            {data.comparison.kind === 'default-branch'
              ? t('orchestration.comparisonDefault', { ref: data.comparison.ref })
              : t(`orchestration.comparison.${data.comparison.kind}`)}
          </p>
        )}
        {source.kind === 'dispatch' && (
          <p className="mt-1 text-muted-foreground">{t('orchestration.historicalReview')}</p>
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
          source={source}
          section="uncommitted"
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
        source={source}
        section="committed"
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

/** 一组改动（未提交 / 已提交）：文件树，点击后在中央工作区打开 diff。 */
function ChangeSet({
  source,
  section,
  title,
  files: names,
  diff,
  empty,
}: {
  source: DiffSource;
  section: DiffSection;
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
  const diffTabs = diffTabsStoreFor(source.workspaceId);
  const selected = diffTabs((state) => state.opened.find((tab) => tab.id === state.selectedId));
  const activePath =
    selected &&
    diffSourceKey(selected.source) === diffSourceKey(source) &&
    selected.section === section
      ? selected.path
      : null;
  const t = useT();

  const openFile = ({ path, oldPath, status }: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) =>
    diffTabs.getState().open({ source, section, path, oldPath, status });

  return (
    <SectionBox title={title} count={files.length + extra.length}>
      {files.length === 0 && extra.length === 0 ? (
        <SectionNote>{empty}</SectionNote>
      ) : (
        <>
          {files.length > 0 && <FileTree nodes={tree} activePath={activePath} onOpen={openFile} />}
          {extra.map((path) => (
            <button
              key={path}
              type="button"
              aria-pressed={activePath === path}
              className={cn(
                'rounded-md border px-2 py-1.5 text-left font-mono text-[11px] outline-none hover:bg-accent focus-visible:bg-accent',
                activePath === path && 'bg-accent'
              )}
              onClick={() => openFile({ path, status: 'modified' })}
            >
              {path}{' '}
              <span className="font-sans text-muted-foreground">
                {t('orchestration.noTextDiff')}
              </span>
            </button>
          ))}
        </>
      )}
    </SectionBox>
  );
}

const TREE_INDENT_PX = 12;

/** VS Code 式目录树：目录行折叠 / 展开，文件行点击打开中央 diff 标签。 */
function FileTree({
  nodes,
  activePath,
  onOpen,
}: {
  nodes: FileTreeNode[];
  activePath: string | null;
  onOpen: (file: DiffFile) => void;
}) {
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
      rows.push(
        // 同一路径可能出现两次（类型变更 = 删除 + 新增），按状态 + 路径区分。
        <li key={`f:${file.status}:${file.oldPath ?? ''}:${file.path}`}>
          <button
            type="button"
            aria-pressed={activePath === file.path}
            className={cn(
              'flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[11px] outline-none hover:bg-accent focus-visible:bg-accent',
              activePath === file.path && 'bg-accent'
            )}
            // 与目录行的 chevron（size-3 + gap）对齐
            style={{ paddingLeft: indent + 16 }}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            onClick={() => onOpen(file)}
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
