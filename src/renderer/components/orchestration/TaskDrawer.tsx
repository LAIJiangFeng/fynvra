import type { Dispatch, Task } from '@fynvra/core';
import { ArrowLeft, ChevronRight, GitBranch, GitCompareArrows, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { OrchestrationSnapshotView } from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import { dispatchesOf, latestDispatchOf } from '@/stores/orchestration';
import { RoleBadge, SectionTitle, StatusBadge, StatusDot } from './common';
import { formatClock, formatDuration } from './format';
import { useNow } from './hooks';
import { MessageStream } from './MessageStream';
import { WorkerOutput } from './WorkerOutput';

/**
 * 任务详情：盖在面板上的抽屉（非模态，Esc 或「返回」关闭）。只读：合并 / 打回是主 agent 的事，
 * 用户通过对话指挥它。
 */
export function TaskDrawer({
  view,
  task,
  onClose,
  onOpenTask,
  onReview,
}: {
  view: OrchestrationSnapshotView;
  task: Task;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onReview: (dispatchId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispatches = dispatchesOf(view, task.id);
  const latest = latestDispatchOf(view, task.id);
  // 无 git 的尝试原地进行：没有分支，也没有 diff 可看
  const inPlace = latest?.mode === 'in-place';
  const reviewable =
    latest && !inPlace && (task.status === 'in-review' || task.status === 'completed');

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`任务详情：${task.title}`}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex flex-col bg-sidebar outline-none transition-[opacity,translate] duration-150 starting:translate-x-3 starting:opacity-0"
      onKeyDown={(event) => {
        // 下拉等经 Portal 渲染在抽屉之外：它们自己处理 Esc
        if (event.key === 'Escape' && containerRef.current?.contains(event.target as Node)) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-start gap-1.5 border-b px-2 py-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="返回任务列表"
          title="返回任务列表（Esc）"
          onClick={onClose}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-sm leading-snug">{task.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.status} />
            <RoleBadge roleId={task.roleId} />
            {latest && !inPlace && (
              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{latest.branch}</span>
              </span>
            )}
          </div>
        </div>
        {reviewable && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => onReview(latest.id)}
          >
            <GitCompareArrows />
            查看改动
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <BriefSection spec={task.spec} />
        {task.dependsOn.length > 0 && (
          <DependencySection view={view} task={task} onOpenTask={onOpenTask} />
        )}
        <section aria-label="尝试">
          <SectionTitle>尝试（{dispatches.length}）</SectionTitle>
          {dispatches.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {task.status === 'todo' ? '等待依赖完成后派发' : '还没有派发'}
            </p>
          ) : (
            <DispatchTimeline dispatches={dispatches} latestId={latest?.id} />
          )}
        </section>
        <section aria-label="消息">
          <SectionTitle>消息</SectionTitle>
          <MessageStream view={view} dispatches={dispatches} />
        </section>
        {latest && <WorkerOutput key={latest.id} dispatchId={latest.id} />}
      </div>
    </div>
  );
}

function BriefSection({ spec }: { spec: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded text-left font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        任务书
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        {spec.trim() === '' ? (
          <p className="text-muted-foreground text-xs">（空）</p>
        ) : (
          <div className="rounded-md border bg-card px-2.5 py-2 text-xs leading-relaxed">
            <MarkdownLite text={spec} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 任务书的轻量展示：标题行加粗，空行收成小间距，其余按原文换行（不引入 Markdown 渲染库）。 */
function MarkdownLite({ text }: { text: string }) {
  return text.split('\n').map((line, index) => {
    const key = `${index}:${line}`;
    if (line.trim() === '') return <div key={key} aria-hidden className="h-1.5" />;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      return (
        <p key={key} className="font-semibold text-foreground">
          {heading[1]}
        </p>
      );
    }
    return (
      <p key={key} className="whitespace-pre-wrap break-words text-foreground/90">
        {line}
      </p>
    );
  });
}

function DependencySection({
  view,
  task,
  onOpenTask,
}: {
  view: OrchestrationSnapshotView;
  task: Task;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section aria-label="依赖">
      <SectionTitle>依赖</SectionTitle>
      <ul className="flex flex-col gap-1">
        {task.dependsOn.map((id) => {
          const dependency = view.tasks.find((candidate) => candidate.id === id);
          return (
            <li key={id}>
              {dependency ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={() => onOpenTask(id)}
                >
                  <StatusDot status={dependency.status} />
                  <span className="min-w-0 flex-1 truncate">{dependency.title}</span>
                  {dependency.status !== 'completed' && (
                    <span className="shrink-0 text-amber-700 text-[11px] dark:text-amber-300">
                      未完成
                    </span>
                  )}
                </button>
              ) : (
                <span className="px-1 font-mono text-muted-foreground text-xs">
                  {id}（已不存在）
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DispatchTimeline({
  dispatches,
  latestId,
}: {
  dispatches: Dispatch[];
  latestId: string | undefined;
}) {
  const running = dispatches.some((dispatch) => dispatch.settledAt === undefined);
  const now = useNow(1_000, running);
  return (
    <ol className="relative flex flex-col gap-3 border-l pl-3">
      {dispatches.map((dispatch, index) => {
        const { settledAt } = dispatch;
        const superseded = dispatch.id !== latestId;
        return (
          <li key={dispatch.id} className={cn('relative', superseded && 'opacity-70')}>
            <span
              aria-hidden
              className={cn(
                'absolute top-1 -left-[17px] size-2 rounded-full ring-2 ring-sidebar',
                settledAt === undefined
                  ? 'bg-sky-500'
                  : dispatch.outcome === 'failed'
                    ? 'bg-destructive'
                    : 'bg-emerald-500'
              )}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">第 {index + 1} 次</span>
              {settledAt === undefined ? (
                <Badge className="border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300">
                  <Loader2 className="animate-spin" />
                  运行中
                </Badge>
              ) : dispatch.outcome === 'failed' ? (
                <Badge variant="destructive">失败</Badge>
              ) : (
                <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  成功
                </Badge>
              )}
              {superseded && (
                <span className="text-[11px] text-muted-foreground">已被后续尝试取代</span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
              开始 {formatClock(dispatch.startedAt, now)}
              {settledAt !== undefined ? (
                <>
                  {' '}
                  · 结束 {formatClock(settledAt, now)} · 用时{' '}
                  {formatDuration(settledAt - dispatch.startedAt)}
                </>
              ) : (
                <> · 已运行 {formatDuration(now - dispatch.startedAt)}</>
              )}
            </p>
            {dispatch.summary && (
              <p className="mt-1 whitespace-pre-wrap break-words text-xs">{dispatch.summary}</p>
            )}
            {dispatch.filesModified && dispatch.filesModified.length > 0 && (
              <FilesModified files={dispatch.filesModified} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function FilesModified({ files }: { files: string[] }) {
  return (
    <Collapsible defaultOpen={files.length <= 5} className="mt-1">
      <CollapsibleTrigger className="group flex items-center gap-1 rounded text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        改动文件（{files.length}）
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-0.5 flex flex-col pl-4 font-mono text-[11px] text-muted-foreground">
          {files.map((file) => (
            <li key={file} className="truncate" title={file}>
              {file}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
