import {
  CircleAlert,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import type { DiffTab } from '@/stores/diffTabs';
import { loadSourceDiff, useSourceDiff } from '@/stores/sessionChanges';
import { PanelMessage } from './common';
import { type DiffFile, parseUnifiedDiff } from './diff';
import { LazyDiffBody, LineCounts, PathText, STATUS_MARK } from './diffView';
import { shortSha } from './format';

/** 已打开的 diff 与文件编辑器一样，切换标签时保持挂载和滚动位置。 */
export function DiffTabPane({ tab }: { tab: DiffTab }) {
  const entry = useSourceDiff(tab.source);
  const t = useT();
  const data = entry?.status === 'ready' ? entry.data : undefined;
  const section = tab.section === 'uncommitted' ? data?.uncommitted : data;
  const patch = section?.diff ?? '';
  // 类型变更可能为同一路径生成删除 + 新增两段 patch，两段都要显示。
  const files = useMemo(
    () => parseUnifiedDiff(patch).filter((file) => file.path === tab.path),
    [patch, tab.path]
  );

  useEffect(() => {
    if (!entry) void loadSourceDiff(tab.source);
  }, [entry, tab.source]);

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
        <Button size="sm" variant="outline" onClick={() => void loadSourceDiff(tab.source, true)}>
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

  const file = files[0];
  const summary: DiffFile | undefined = file && {
    ...file,
    status: files.length > 1 ? 'modified' : file.status,
    additions: files.reduce((sum, part) => sum + part.additions, 0),
    deletions: files.reduce((sum, part) => sum + part.deletions, 0),
  };
  const status = summary?.status ?? tab.status;
  const mark = STATUS_MARK[status];
  const oldPath = file ? file.oldPath : tab.oldPath;
  const unavailable = tab.section === 'uncommitted' && !entry.data.uncommitted.available;

  return (
    <section aria-label={tab.path} className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b bg-card px-4 py-3 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn('shrink-0 font-mono font-semibold', mark.className)}
            title={t(`orchestration.fileStatus.${status}`)}
          >
            <span aria-hidden>{mark.letter}</span>
            <span className="sr-only">{t(`orchestration.fileStatus.${status}`)}</span>
          </span>
          <span className="min-w-0 flex-1 break-words font-mono">
            {oldPath && (
              <span className="text-muted-foreground">
                <PathText path={oldPath} />
                {' → '}
              </span>
            )}
            <PathText path={tab.path} />
          </span>
          {summary && <LineCounts file={summary} />}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('orchestration.reloadDiff')}
            title={t('orchestration.reloadDiff')}
            disabled={entry.refreshing}
            onClick={() => void loadSourceDiff(tab.source, true)}
          >
            <RefreshCw className={cn(entry.refreshing && 'animate-spin')} />
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5" title={entry.data.branch}>
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">
              {entry.data.branch || t('orchestration.detachedHead')}
              {'headCommit' in entry.data &&
                entry.data.headCommit &&
                ` · ${shortSha(entry.data.headCommit)}`}
            </span>
          </span>
          <span className="flex items-center gap-1.5" title={entry.data.baseCommit}>
            <GitCommitHorizontal className="size-3.5 shrink-0" />
            {t('orchestration.base')}
            <span className="font-mono">{shortSha(entry.data.baseCommit)}</span>
          </span>
          {'comparison' in entry.data && (
            <span>
              {entry.data.comparison.kind === 'default-branch'
                ? t('orchestration.comparisonDefault', { ref: entry.data.comparison.ref })
                : t(`orchestration.comparison.${entry.data.comparison.kind}`)}
            </span>
          )}
          <span>
            {t(
              tab.section === 'committed'
                ? 'orchestration.committedChanges'
                : 'orchestration.uncommittedChanges'
            )}
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {unavailable || files.length === 0 ? (
          <PanelMessage
            icon={GitCompareArrows}
            title={t(
              unavailable
                ? 'orchestration.worktreeRemoved'
                : section?.files.includes(tab.path)
                  ? 'orchestration.noTextChanges'
                  : 'orchestration.diffFileGone'
            )}
          />
        ) : (
          files.map((part) => (
            <LazyDiffBody
              key={`${part.status}:${part.oldPath ?? ''}:${part.path}:${part.binary}:${part.hunks.length === 0}`}
              file={part}
            />
          ))
        )}
      </div>
    </section>
  );
}
