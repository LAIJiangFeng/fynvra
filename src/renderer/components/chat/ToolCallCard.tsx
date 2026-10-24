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
import { memo, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
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

/** 工具调用卡片：名称、参数摘要、耗时、状态；展开看完整参数与输出。 */
export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ChatToolCall }) {
  if (call.name === 'dispatch_task') return <DispatchTaskCard call={call} />;
  if (call.name === 'report_done') return <ReportDoneCard call={call} />;
  return <GenericToolCard call={call} />;
});

function GenericToolCard({ call }: { call: ChatToolCall }) {
  const display = describeTool(call.name, call.args);
  const style = FAMILY_STYLE[display.family];
  const Icon = iconOf(call.name, display.family);
  const markdownOutput = display.family === 'orchestration' || display.family === 'worker';

  return (
    <Collapsible className={cn('rounded-md border text-sm', style.card)}>
      <CardTrigger
        icon={<Icon className={cn('size-3.5 shrink-0', style.icon)} />}
        title={<span className="shrink-0 font-medium">{display.label}</span>}
        summary={display.summary}
        call={call}
      />
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {call.args !== undefined && prettyArgs(call.args) !== '{}' && (
          <Section title="参数">
            <Pre>{prettyArgs(call.args)}</Pre>
          </Section>
        )}
        <Section title="输出">
          <Output call={call} markdown={markdownOutput} />
        </Section>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 主 agent 派发任务：突出任务标题与执行角色 */
function DispatchTaskCard({ call }: { call: ChatToolCall }) {
  const task = dispatchTaskView(call.args);
  const style = FAMILY_STYLE.orchestration;

  return (
    <Collapsible className={cn('rounded-md border text-sm', style.card)}>
      <CardTrigger
        icon={<Send className={cn('size-3.5 shrink-0', style.icon)} />}
        title={
          <>
            <span className={cn('shrink-0 font-medium text-xs', style.icon)}>派发任务</span>
            <span className="min-w-0 truncate font-medium">{task.title || '（未命名任务）'}</span>
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
            依赖
            {task.dependsOn.map((id) => (
              <Badge key={id} variant="outline" className="font-mono">
                {id}
              </Badge>
            ))}
          </p>
        )}
        {task.spec && (
          <Section title="任务书">
            <div className="max-h-80 overflow-auto rounded border bg-background/60 px-3 py-2">
              <Markdown text={task.spec} />
            </div>
          </Section>
        )}
        <Section title="结果">
          <Output call={call} markdown />
        </Section>
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTCOME = {
  succeeded: {
    label: '成功',
    card: 'border-emerald-500/30 bg-emerald-500/5',
    badge: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  failed: {
    label: '失败',
    card: 'border-destructive/30 bg-destructive/5',
    badge: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  },
} as const;

const FILES_PREVIEW = 8;

/** worker 汇报结果：结果、总结、改动文件 */
function ReportDoneCard({ call }: { call: ChatToolCall }) {
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
            <span className="shrink-0 font-medium">汇报结果</span>
            {outcome && <Badge className={cn('shrink-0', outcome.badge)}>{outcome.label}</Badge>}
          </>
        }
        call={call}
      />
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {report.summary && <p className="whitespace-pre-wrap break-words">{report.summary}</p>}
        {files.length > 0 && (
          <Section title={`改动文件（${files.length}）`}>
            <ul className="space-y-0.5 font-mono text-xs">
              {files.slice(0, FILES_PREVIEW).map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
              {files.length > FILES_PREVIEW && (
                <li className="text-muted-foreground">…等 {files.length} 个文件</li>
              )}
            </ul>
          </Section>
        )}
        {call.status === 'error' && (
          <Section title="输出">
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
}: {
  icon: ReactNode;
  title: ReactNode;
  summary?: string;
  call: ChatToolCall;
}) {
  return (
    <CollapsibleTrigger className="group/tool flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
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
  if (status === 'running') {
    return <LoaderCircle aria-label="运行中" className="size-3.5 animate-spin" />;
  }
  if (status === 'error') {
    return <CircleX aria-label="失败" className="size-3.5 text-destructive" />;
  }
  return (
    <CircleCheck aria-label="完成" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
  );
}

function Output({ call, markdown }: { call: ChatToolCall; markdown: boolean }) {
  if (call.output) {
    return markdown ? (
      <div className="max-h-80 overflow-auto rounded border bg-background/60 px-3 py-2">
        <Markdown text={call.output} />
      </div>
    ) : (
      <Pre className={cn(call.status === 'error' && 'text-destructive')}>{call.output}</Pre>
    );
  }
  const placeholder =
    call.status === 'running'
      ? '运行中…'
      : call.status === 'error'
        ? '已中断，没有输出'
        : '（无输出）';
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
