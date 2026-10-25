import type { ChatToolCall } from '@shared/types/chat';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Flag,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitMerge,
  Hourglass,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  Plug,
  ScrollText,
  Search,
  Send,
  SquareTerminal,
  Trash2,
  Undo2,
  Users,
  Wrench,
} from 'lucide-react';
import { memo, type ReactNode, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type DiffLine, diffEdit, type FileChange, fileChangeOf } from '@/stores/sessions/timeline';
import { useGeneralPreferencesStore } from '@/stores/settings';
import { formatDuration } from './format';
import { Markdown } from './Markdown';
import {
  describeTool,
  dispatchTaskView,
  prettyArgs,
  reportDoneView,
  type ToolFamily,
} from './toolDisplay';

const ICONS: Record<string, LucideIcon> = {
  read: FileText,
  bash: SquareTerminal,
  edit: FilePen,
  write: FilePlus,
  grep: Search,
  find: FileSearch,
  ls: FolderOpen,
  git_readonly: GitBranch,
  dispatch_task: Send,
  list_workers: Users,
  wait_for_workers: Hourglass,
  read_worker_output: ScrollText,
  send_to_worker: MessageSquare,
  review_diff: GitCompare,
  run_checks: ListChecks,
  merge_worktree: GitMerge,
  reject_work: Undo2,
  cleanup_worktree: Trash2,
  ask_coordinator: MessageCircleQuestion,
  report_done: Flag,
};

/** 编排 / worker 工具有专门的配色，和普通编程工具区分开 */
const FAMILY_STYLE: Record<ToolFamily, { card: string; icon: string }> = {
  builtin: { card: 'bg-card', icon: 'text-muted-foreground' },
  other: { card: 'bg-card', icon: 'text-muted-foreground' },
  mcp: { card: 'bg-card', icon: 'text-muted-foreground' },
  orchestration: {
    card: 'border-violet-500/30 bg-violet-500/5',
    icon: 'text-violet-600 dark:text-violet-400',
  },
  worker: { card: 'border-sky-500/30 bg-sky-500/5', icon: 'text-sky-600 dark:text-sky-400' },
};

function iconOf(name: string, family: ToolFamily): LucideIcon {
  return ICONS[name] ?? (family === 'mcp' ? Plug : Wrench);
}

/**
 * 工具调用卡片：名称、参数摘要、耗时、状态；展开看完整参数与输出。
 * `live`：卡片属于正在跑的这一轮（edit / write 按设置自动展开改动）。
 */
export const ToolCallCard = memo(function ToolCallCard({
  call,
  live = false,
}: {
  call: ChatToolCall;
  live?: boolean;
}) {
  if (call.name === 'dispatch_task') return <DispatchTaskCard call={call} />;
  if (call.name === 'report_done') return <ReportDoneCard call={call} />;
  return <GenericToolCard call={call} live={live} />;
});

function GenericToolCard({ call, live }: { call: ChatToolCall; live: boolean }) {
  const t = useT();
  const display = describeTool(call.name, call.args, t);
  const style = FAMILY_STYLE[display.family];
  const Icon = iconOf(call.name, display.family);
  const markdownOutput = display.family === 'orchestration' || display.family === 'worker';
  const change = fileChangeOf(call.name, call.args);
  const autoExpandEdits = useGeneralPreferencesStore((state) => state.timeline.autoExpandEdits);
  // edit / write 在这一轮还在跑时自动展开改动（工具本身常常几毫秒就结束，不看它自己的状态）；
  // 之前轮次的照常折叠。展开后不自动收起，用户收起的也不再弹开
  const autoOpen = change !== null && autoExpandEdits && (live || call.status === 'running');
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setOpen(next)}
      className={cn('rounded-md border text-sm', style.card)}
    >
      <CardTrigger
        icon={<Icon className={cn('size-3.5 shrink-0', style.icon)} />}
        title={<span className="shrink-0 font-medium">{display.label}</span>}
        summary={display.summary}
        call={call}
      />
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {change ? (
          <FileChangeView change={change} />
        ) : (
          call.args !== undefined &&
          prettyArgs(call.args) !== '{}' && (
            <Section title={t('tools.args')}>
              <Pre>{prettyArgs(call.args)}</Pre>
            </Section>
          )
        )}
        <Section title={t('tools.output')}>
          <Output call={call} markdown={markdownOutput} />
        </Section>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** diff 太长时只画前这么多行（每行一个元素） */
const DIFF_PREVIEW_LINES = 400;

const DIFF_LINE_STYLE: Record<DiffLine['sign'], string> = {
  ' ': '',
  '-': 'bg-red-500/10 text-red-700 dark:text-red-300',
  '+': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};

/** edit 的改动（逐处替换的行级 diff）或 write 写入的内容 */
function FileChangeView({ change }: { change: FileChange }) {
  const t = useT();
  if (change.kind === 'write') {
    return (
      <Section title={t('tools.content')}>
        <Pre>{change.content}</Pre>
      </Section>
    );
  }
  const hunks = change.edits.map(diffEdit);
  const total = hunks.reduce((sum, lines) => sum + lines.length, 0);
  let budget = DIFF_PREVIEW_LINES;
  return (
    <Section title={t('tools.changes')}>
      <div className="max-h-80 overflow-auto rounded border bg-background/60 py-1 font-mono text-xs leading-relaxed">
        {hunks.map((lines, hunk) => {
          const shown = lines.slice(0, Math.max(0, budget));
          budget -= shown.length;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 改动是参数里的静态列表，不会重排
            <div key={hunk} className={cn(hunk > 0 && 'mt-1 border-t pt-1')}>
              {shown.map((line, at) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                  key={at}
                  className={cn('whitespace-pre-wrap break-all px-2', DIFF_LINE_STYLE[line.sign])}
                >
                  {line.sign} {line.text}
                </div>
              ))}
            </div>
          );
        })}
        {total > DIFF_PREVIEW_LINES && (
          <div className="px-2 text-muted-foreground">
            {t('tools.moreLines', { count: total - DIFF_PREVIEW_LINES })}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * 精简显示的只读工具（read / grep / find / ls）：一个就是一行；连续多个合成一条「N 次读取」，
 * 展开看每一行。每行再展开看输出。
 */
export const ReadonlyTools = memo(function ReadonlyTools({ calls }: { calls: ChatToolCall[] }) {
  const t = useT();
  const [first] = calls;
  if (calls.length === 1 && first) return <CompactToolLine call={first} />;
  const status: ChatToolCall['status'] = calls.some((call) => call.status === 'running')
    ? 'running'
    : calls.some((call) => call.status === 'error')
      ? 'error'
      : 'done';
  const summary = calls
    .map((call) => describeTool(call.name, call.args, t).summary)
    .filter(Boolean)
    .join(' · ');
  return (
    <Collapsible className="text-sm">
      <CollapsibleTrigger className="group/reads flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <FileSearch className="size-3.5 shrink-0" />
        <span className="shrink-0">{t('tools.reads', { count: calls.length })}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs">
          <StatusIcon status={status} />
          <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/reads:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-4 border-l pl-1">
        {calls.map((call) => (
          <CompactToolLine key={call.id} call={call} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
});

/** 单行的工具调用：没有卡片边框，图标、名称、参数摘要、耗时与状态；展开看输出 */
function CompactToolLine({ call }: { call: ChatToolCall }) {
  const t = useT();
  const display = describeTool(call.name, call.args, t);
  const Icon = iconOf(call.name, display.family);
  return (
    <Collapsible className="text-muted-foreground text-sm">
      <CardTrigger
        compact
        icon={<Icon className="size-3.5 shrink-0" />}
        title={<span className="shrink-0">{display.label}</span>}
        summary={display.summary}
        call={call}
      />
      <CollapsibleContent className="px-3 pb-1.5">
        <Output call={call} markdown={false} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 主 agent 派发任务：突出任务标题与执行角色 */
function DispatchTaskCard({ call }: { call: ChatToolCall }) {
  const t = useT();
  const task = dispatchTaskView(call.args);
  const style = FAMILY_STYLE.orchestration;

  return (
    <Collapsible className={cn('rounded-md border text-sm', style.card)}>
      <CardTrigger
        icon={<Send className={cn('size-3.5 shrink-0', style.icon)} />}
        title={
          <>
            <span className={cn('shrink-0 font-medium text-xs', style.icon)}>
              {t('tools.labels.dispatch_task')}
            </span>
            <span className="min-w-0 truncate font-medium">
              {task.title || t('tools.untitledTask')}
            </span>
            <Badge variant="outline" className="shrink-0">
              {task.role}
            </Badge>
          </>
        }
        call={call}
      />
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {task.dependsOn.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
            {t('tools.dependsOn')}
            {task.dependsOn.map((id) => (
              <Badge key={id} variant="outline" className="font-mono">
                {id}
              </Badge>
            ))}
          </p>
        )}
        {task.spec && (
          <Section title={t('tools.brief')}>
            <div className="max-h-80 overflow-auto rounded border bg-background/60 px-3 py-2">
              <Markdown text={task.spec} />
            </div>
          </Section>
        )}
        <Section title={t('tools.result')}>
          <Output call={call} markdown />
        </Section>
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTCOME = {
  succeeded: {
    card: 'border-emerald-500/30 bg-emerald-500/5',
    badge: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  failed: {
    card: 'border-destructive/30 bg-destructive/5',
    badge: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  },
} as const;

const FILES_PREVIEW = 8;

/** worker 汇报结果：结果、总结、改动文件 */
function ReportDoneCard({ call }: { call: ChatToolCall }) {
  const t = useT();
  const report = reportDoneView(call.args);
  const outcome = report.outcome ? OUTCOME[report.outcome] : null;
  const style = FAMILY_STYLE.worker;
  const files = report.filesModified;

  return (
    <Collapsible
      defaultOpen
      className={cn('rounded-md border text-sm', outcome?.card ?? style.card)}
    >
      <CardTrigger
        icon={<Flag className={cn('size-3.5 shrink-0', style.icon)} />}
        title={
          <>
            <span className="shrink-0 font-medium">{t('tools.labels.report_done')}</span>
            {report.outcome && outcome && (
              <Badge className={cn('shrink-0', outcome.badge)}>
                {t(`tools.outcome.${report.outcome}`)}
              </Badge>
            )}
          </>
        }
        call={call}
      />
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {report.summary && <p className="whitespace-pre-wrap break-words">{report.summary}</p>}
        {files.length > 0 && (
          <Section title={t('tools.filesChanged', { count: files.length })}>
            <ul className="space-y-0.5 font-mono text-xs">
              {files.slice(0, FILES_PREVIEW).map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
              {files.length > FILES_PREVIEW && (
                <li className="text-muted-foreground">
                  {t('tools.moreFiles', { count: files.length })}
                </li>
              )}
            </ul>
          </Section>
        )}
        {call.status === 'error' && (
          <Section title={t('tools.output')}>
            <Output call={call} markdown />
          </Section>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CardTrigger({
  icon,
  title,
  summary,
  call,
  compact = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  summary?: string;
  call: ChatToolCall;
  /** 单行显示（没有卡片边框）：行更矮，悬停时变亮 */
  compact?: boolean;
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        'group/tool flex w-full min-w-0 items-center gap-2 rounded-md px-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        compact ? 'py-1 hover:text-foreground' : 'py-1.5'
      )}
    >
      {icon}
      {title}
      {summary ? (
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {summary}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
        {call.durationMs !== undefined && formatDuration(call.durationMs)}
        <StatusIcon status={call.status} />
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/tool:rotate-90" />
      </span>
    </CollapsibleTrigger>
  );
}

function StatusIcon({ status }: { status: ChatToolCall['status'] }) {
  const t = useT();
  if (status === 'running') {
    return <LoaderCircle aria-label={t('tools.running')} className="size-3.5 animate-spin" />;
  }
  if (status === 'error') {
    return <CircleX aria-label={t('tools.failed')} className="size-3.5 text-destructive" />;
  }
  return (
    <CircleCheck
      aria-label={t('tools.done')}
      className="size-3.5 text-emerald-600 dark:text-emerald-400"
    />
  );
}

function Output({ call, markdown }: { call: ChatToolCall; markdown: boolean }) {
  const t = useT();
  if (call.output) {
    return markdown ? (
      <div className="max-h-80 overflow-auto rounded border bg-background/60 px-3 py-2">
        <Markdown text={call.output} />
      </div>
    ) : (
      <Pre className={cn(call.status === 'error' && 'text-destructive')}>{call.output}</Pre>
    );
  }
  const placeholder = t(
    call.status === 'running'
      ? 'tools.runningOutput'
      : call.status === 'error'
        ? 'tools.interrupted'
        : 'tools.noOutput'
  );
  return <p className="text-muted-foreground text-xs">{placeholder}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-muted-foreground text-xs">{title}</div>
      {children}
    </div>
  );
}

function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border bg-background/60 px-2 py-1.5 font-mono text-xs leading-relaxed',
        className
      )}
    >
      {children}
    </pre>
  );
}
