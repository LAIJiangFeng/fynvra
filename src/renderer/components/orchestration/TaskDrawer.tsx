import type { Dispatch, Task, TaskWorkflow } from '@fynvra/core';
import { ArrowLeft, ChevronRight, GitBranch, GitCompareArrows, Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/I18nProvider';
import type { OrchestrationSnapshotView } from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import { dispatchesOf, latestDispatchOf, messagesOf } from '@/stores/orchestration';
import { CompactMarkdown } from './CompactMarkdown';
import {
  RoleBadge,
  SectionTitle,
  StatusBadge,
  StatusDot,
  WorkflowProgress,
  workflowNodeDispatchId,
} from './common';
import { formatClock, formatDuration, splitSummary } from './format';
import { useNow } from './hooks';
import { MessageStream } from './MessageStream';
import { WorkerOutput } from './WorkerOutput';
import { WorkflowRunGraph } from './WorkflowRunGraph';

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
  focusNode,
}: {
  view: OrchestrationSnapshotView;
  task: Task;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onReview: (dispatchId: string) => void;
  /** 从对话里请求定位的工作流节点；`seq` 变化时把输出切到该节点最新一次尝试 */
  focusNode?: { nodeId: string; seq: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const dispatches = dispatchesOf(view, task.id);
  const latest = latestDispatchOf(view, task.id);
  // 无 git 的尝试原地进行：没有分支，也没有 diff 可看
  const inPlace = latest?.mode === 'in-place';
  const reviewable =
    latest && !inPlace && (task.status === 'in-review' || task.status === 'completed');
  // 在流程图里点选的节点及其尝试；没有时输出区显示最新一次尝试
  const [picked, setPicked] = useState<{ nodeId: string; dispatchId: string } | null>(null);
  const pickedValid = picked && dispatches.some((dispatch) => dispatch.id === picked.dispatchId);
  const outputId = pickedValid ? picked.dispatchId : latest?.id;
  const outputRef = useRef<HTMLDivElement>(null);
  const outputSettled =
    dispatches.find((dispatch) => dispatch.id === outputId)?.settledAt !== undefined;
  // 已结算的输出默认收起（收起时不挂载、不加载）；定位到节点时自动展开
  const [outputOpen, setOutputOpen] = useState(false);
  const revealOutput = () => {
    setOutputOpen(true);
    window.requestAnimationFrame(() =>
      outputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    );
  };
  const settledTask = task.status === 'completed' || task.status === 'abandoned';
  const messageCount = dispatches.reduce(
    (sum, dispatch) => sum + messagesOf(view, dispatch.id).length,
    0
  );
  const pickedName =
    pickedValid && task.workflow && Array.isArray(task.workflow.steps)
      ? (task.workflow.steps.find((step) => step.id === picked.nodeId)?.name ?? picked.nodeId)
      : null;

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // 只在请求序号变化时定位一次，之后快照更新不再覆盖用户在图里的选择
  const focusSeq = focusNode?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按请求序号触发
  useEffect(() => {
    if (!focusNode || !task.workflow) return;
    const dispatchId = workflowNodeDispatchId(task.workflow, dispatches, focusNode.nodeId);
    if (!dispatchId) return;
    setPicked({ nodeId: focusNode.nodeId, dispatchId });
    revealOutput();
  }, [focusSeq]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={t('orchestration.taskDetails', { title: task.title })}
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
          aria-label={t('orchestration.backToTasks')}
          title={t('orchestration.backToTasksHint')}
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
          {task.workflow && <WorkflowProgress workflow={task.workflow} className="mt-1.5" />}
        </div>
        {reviewable && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => onReview(latest.id)}
          >
            <GitCompareArrows />
            {t('orchestration.viewChanges')}
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {latest && latest.settledAt !== undefined && latest.summary?.trim() && (
          <ResultCard dispatch={latest} attempt={dispatches.length} />
        )}
        <BriefSection spec={task.spec} />
        {task.dependsOn.length > 0 && (
          <DependencySection view={view} task={task} onOpenTask={onOpenTask} />
        )}
        {task.workflow && (
          <WorkflowRunGraph
            workflow={task.workflow}
            dispatches={dispatches}
            selectedNodeId={pickedValid ? picked.nodeId : null}
            onOpenOutput={(nodeId, dispatchId) => {
              setPicked({ nodeId, dispatchId });
              revealOutput();
            }}
          />
        )}
        {task.workflow && <WorkflowHistory workflow={task.workflow} />}
        <section aria-label={t('orchestration.attempts')}>
          <SectionTitle>
            {t('orchestration.attemptsCount', { count: dispatches.length })}
          </SectionTitle>
          {dispatches.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t(
                task.status === 'todo' ? 'orchestration.waitingDeps' : 'orchestration.notDispatched'
              )}
            </p>
          ) : (
            <DispatchTimeline dispatches={dispatches} latestId={latest?.id} />
          )}
        </section>
        {settledTask ? (
          <Fold label={t('orchestration.messagesCount', { count: messageCount })}>
            <MessageStream view={view} dispatches={dispatches} />
          </Fold>
        ) : (
          <section aria-label={t('orchestration.messages')}>
            <SectionTitle>{t('orchestration.messages')}</SectionTitle>
            <MessageStream view={view} dispatches={dispatches} />
          </section>
        )}
        {outputId && (
          <div ref={outputRef} className="flex flex-col gap-1">
            {pickedName !== null && (
              <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {t('orchestration.workflow.viewingNode', { name: pickedName })}
                </span>
                {outputId !== latest?.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 shrink-0 px-1.5 text-[11px]"
                    onClick={() => setPicked(null)}
                  >
                    {t('orchestration.workflow.viewLatest')}
                  </Button>
                )}
              </p>
            )}
            {outputSettled ? (
              <Fold
                label={t('orchestration.output')}
                open={outputOpen}
                onOpenChange={setOutputOpen}
              >
                <WorkerOutput key={outputId} dispatchId={outputId} hideTitle />
              </Fold>
            ) : (
              <WorkerOutput key={outputId} dispatchId={outputId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 小节级折叠区（默认收起，收起时内容不挂载）。 */
function Fold({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded text-left font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function BriefSection({ spec }: { spec: string }) {
  const t = useT();
  return (
    <Fold label={t('orchestration.brief')}>
      {spec.trim() === '' ? (
        <p className="text-muted-foreground text-xs">{t('orchestration.emptyBrief')}</p>
      ) : (
        <div className="rounded-md border bg-card px-2.5 py-2">
          <CompactMarkdown text={spec} className="text-xs leading-relaxed" />
        </div>
      )}
    </Fold>
  );
}

/** 顶部结果卡：最新一次已结算尝试的汇报首段、元信息、完整汇报与改动文件。 */
function ResultCard({ dispatch, attempt }: { dispatch: Dispatch; attempt: number }) {
  const t = useT();
  const failed = dispatch.outcome === 'failed';
  const { lead, rest } = splitSummary(dispatch.summary ?? '');
  const files = dispatch.filesModified ?? [];
  const meta = [t('orchestration.attemptNth', { count: attempt })];
  if (dispatch.settledAt !== undefined) {
    meta.push(
      t('orchestration.took', {
        duration: formatDuration(dispatch.settledAt - dispatch.startedAt, t),
      })
    );
  }
  if (files.length > 0) meta.push(t('orchestration.filesCount', { count: files.length }));
  return (
    <section
      aria-label={t(failed ? 'orchestration.whyFailed' : 'orchestration.whatWasDone')}
      className={cn(
        'rounded-md border border-l-2 bg-card px-3 py-2',
        failed ? 'border-l-destructive' : 'border-l-emerald-500'
      )}
    >
      <h3
        className={cn(
          'font-medium text-xs',
          failed ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300'
        )}
      >
        {t(failed ? 'orchestration.whyFailed' : 'orchestration.whatWasDone')}
      </h3>
      <CompactMarkdown text={lead} className="mt-1 text-[13px] leading-relaxed" />
      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">{meta.join(' · ')}</p>
      {rest && (
        <Collapsible className="mt-1">
          <CollapsibleTrigger className="group flex items-center gap-1 rounded text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
            {t('orchestration.fullReport')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CompactMarkdown text={rest} className="mt-1 pl-4 text-xs" />
          </CollapsibleContent>
        </Collapsible>
      )}
      {files.length > 0 && <FilesModified files={files} />}
    </section>
  );
}

/** 工作流各步的结算记录（最近 30 条），新的在下。 */
function WorkflowHistory({ workflow }: { workflow: TaskWorkflow }) {
  const t = useT();
  // 旧快照可能缺少字段
  const history = Array.isArray(workflow.history) ? workflow.history : [];
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  return (
    <section aria-label={t('orchestration.workflow.history')}>
      <SectionTitle>{t('orchestration.workflow.history')}</SectionTitle>
      {history.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('orchestration.workflow.historyEmpty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {history.map((entry) => (
            <li key={`${entry.dispatchId}:${entry.at}`} className="text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">
                  {t('orchestration.workflow.entry', {
                    step: steps.findIndex((step) => step.id === entry.nodeId) + 1,
                    stepName: steps.find((step) => step.id === entry.nodeId)?.name ?? '?',
                  })}
                </span>
                {entry.outcome === 'failed' ? (
                  <Badge variant="destructive">{t('orchestration.outcome.failed')}</Badge>
                ) : (
                  <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                    {t('orchestration.outcome.succeeded')}
                  </Badge>
                )}
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatClock(entry.at)}
                </span>
              </div>
              {entry.summary && (
                <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
                  {entry.summary}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
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
  const t = useT();
  return (
    <section aria-label={t('orchestration.dependencies')}>
      <SectionTitle>{t('orchestration.dependencies')}</SectionTitle>
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
                      {t('orchestration.unfinished')}
                    </span>
                  )}
                </button>
              ) : (
                <span className="px-1 font-mono text-muted-foreground text-xs">
                  {t('orchestration.missingTask', { id })}
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
  const t = useT();
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
              <span className="font-medium">
                {t('orchestration.attemptShort', { count: index + 1 })}
              </span>
              {settledAt === undefined ? (
                <Badge className="border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300">
                  <Loader2 className="animate-spin" />
                  {t('orchestration.running')}
                </Badge>
              ) : dispatch.outcome === 'failed' ? (
                <Badge variant="destructive">{t('orchestration.outcome.failed')}</Badge>
              ) : (
                <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  {t('orchestration.outcome.succeeded')}
                </Badge>
              )}
              {superseded && (
                <span className="text-[11px] text-muted-foreground">
                  {t('orchestration.superseded')}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
              {t('orchestration.started', { time: formatClock(dispatch.startedAt, now) })}
              {settledAt !== undefined
                ? t('orchestration.ended', {
                    time: formatClock(settledAt, now),
                    duration: formatDuration(settledAt - dispatch.startedAt, t),
                  })
                : t('orchestration.elapsed', {
                    duration: formatDuration(now - dispatch.startedAt, t),
                  })}
            </p>
            {superseded && dispatch.summary && (
              <p
                className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground text-xs"
                title={dispatch.summary}
              >
                {splitSummary(dispatch.summary).lead}
              </p>
            )}
            {(superseded || !dispatch.summary?.trim()) &&
              dispatch.filesModified &&
              dispatch.filesModified.length > 0 && <FilesModified files={dispatch.filesModified} />}
          </li>
        );
      })}
    </ol>
  );
}

function FilesModified({ files }: { files: string[] }) {
  const t = useT();
  return (
    <Collapsible defaultOpen={files.length <= 5} className="mt-1">
      <CollapsibleTrigger className="group flex items-center gap-1 rounded text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        {t('orchestration.filesChanged', { count: files.length })}
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
