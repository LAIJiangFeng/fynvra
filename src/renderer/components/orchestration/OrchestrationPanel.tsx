import {
  CircleAlert,
  FlaskConical,
  GitCompareArrows,
  ListChecks,
  Loader2,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  isOrchestrationDemo,
  setOrchestrationDemo,
  usingOrchestrationMock,
} from '@/lib/api/orchestration';
import { cn } from '@/lib/utils';
import { reviewCandidatesOf, runsOf, useOrchestrationStore } from '@/stores/orchestration';
import { useWorkspacesStore } from '@/stores/workspaces';
import { ChangesView } from './ChangesView';
import { PanelMessage } from './common';
import { TaskDrawer } from './TaskDrawer';
import { TasksView } from './TasksView';

/** 与 store 创建时取的是同一个数据源：同一次页面加载内不会变。 */
const USING_MOCK = usingOrchestrationMock();
/** 演示数据下没选工作区时用的占位 id：mock 对任何工作区都返回同一份数据。 */
const DEMO_WORKSPACE_ID = 'demo';

type PanelTab = 'tasks' | 'changes';

/** 右侧编排面板：「任务」看板与「改动」diff。只读视图，不提供合并 / 打回。 */
export function OrchestrationPanel() {
  const selectedId = useWorkspacesStore((state) => state.selectedId);
  const workspaceId = selectedId ?? (USING_MOCK ? DEMO_WORKSPACE_ID : null);
  if (workspaceId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeaderBar>
          <span className="px-1 font-medium text-muted-foreground text-xs">编排</span>
        </PanelHeaderBar>
        <PanelMessage icon={Workflow} title="选择一个工作区查看编排" />
      </div>
    );
  }
  return <WorkspaceOrchestration key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceOrchestration({ workspaceId }: { workspaceId: string }) {
  const watchWorkspace = useOrchestrationStore((state) => state.watchWorkspace);
  const refresh = useOrchestrationStore((state) => state.refresh);
  const view = useOrchestrationStore((state) => state.snapshots[workspaceId]?.view ?? null);
  const loading = useOrchestrationStore((state) => state.snapshots[workspaceId]?.loading ?? true);
  const error = useOrchestrationStore((state) => state.snapshots[workspaceId]?.error ?? null);

  useEffect(() => watchWorkspace(workspaceId), [watchWorkspace, workspaceId]);

  const [tab, setTab] = useState<PanelTab>('tasks');
  const [runId, setRunId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const runs = useMemo(() => runsOf(view), [view]);
  const run = runs.find((candidate) => candidate.id === runId) ?? runs[0];
  const candidates = reviewCandidatesOf(view, run?.id ?? null);
  const openTask = openTaskId ? view?.tasks.find((task) => task.id === openTaskId) : undefined;
  const taskCount = run && view ? view.tasks.filter((task) => task.runId === run.id).length : 0;

  const closeDrawer = () => {
    setOpenTaskId(null);
    const target = returnFocus.current;
    requestAnimationFrame(() => target?.focus());
  };

  // 两个 tab 共用：还没读到快照（加载中 / 失败）或工作区里还没有编排
  let notice: ReactNode = null;
  if (!view) {
    notice = error ? (
      <PanelMessage icon={CircleAlert} title="读取编排状态失败" description={error}>
        <Button size="sm" variant="outline" onClick={() => void refresh(workspaceId)}>
          <RefreshCw />
          重试
        </Button>
      </PanelMessage>
    ) : (
      <PanelMessage icon={Loader2} spin title="正在读取编排状态…" />
    );
  } else if (!run) {
    notice = (
      <PanelMessage
        icon={Workflow}
        title="主 agent 还没有派发任务"
        description="在 Orchestrator 会话里描述需求，主 agent 会把它拆成任务，为每个任务开 worktree 并派给 worker。"
      />
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value === 'changes' ? 'changes' : 'tasks')}
        className="flex min-h-0 flex-1 flex-col gap-0"
        inert={openTask !== undefined}
      >
        <PanelHeaderBar>
          <TabsList className="h-7">
            <TabsTrigger value="tasks" className="px-2 text-xs">
              <ListChecks />
              任务
              {taskCount > 0 && <Count value={taskCount} />}
            </TabsTrigger>
            <TabsTrigger value="changes" className="px-2 text-xs">
              <GitCompareArrows />
              改动
              {candidates.length > 0 && <Count value={candidates.length} />}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-0.5">
            {USING_MOCK && (
              <Badge variant="outline" className="mr-1 text-[10px]">
                演示数据
              </Badge>
            )}
            {import.meta.env.DEV && <DemoToggle />}
            <Tooltip>
              <TooltipTrigger
                render={<Button size="icon-xs" variant="ghost" aria-label="刷新" />}
                onClick={() => void refresh(workspaceId)}
              >
                <RefreshCw className={cn(loading && 'animate-spin')} />
              </TooltipTrigger>
              <TooltipContent side="bottom">刷新</TooltipContent>
            </Tooltip>
          </div>
        </PanelHeaderBar>
        {view && error && (
          <p
            role="alert"
            className="shrink-0 border-b bg-destructive/10 px-3 py-1 text-destructive text-xs"
          >
            刷新失败：{error}
          </p>
        )}

        <TabsContent value="tasks" className="flex min-h-0 flex-col overflow-y-auto">
          {notice ??
            (view && run && (
              <TasksView
                view={view}
                run={run}
                runs={runs}
                onSelectRun={setRunId}
                onOpenTask={(taskId, trigger) => {
                  returnFocus.current = trigger;
                  setOpenTaskId(taskId);
                }}
              />
            ))}
        </TabsContent>
        <TabsContent value="changes" className="flex min-h-0 flex-col overflow-y-auto">
          {notice ??
            (view && (
              <ChangesView
                view={view}
                candidates={candidates}
                selectedId={reviewId}
                onSelect={setReviewId}
              />
            ))}
        </TabsContent>
      </Tabs>

      {view && openTask && (
        <TaskDrawer
          key={openTask.id}
          view={view}
          task={openTask}
          onClose={closeDrawer}
          onOpenTask={setOpenTaskId}
          onReview={(dispatchId) => {
            setReviewId(dispatchId);
            setTab('changes');
            setOpenTaskId(null);
          }}
        />
      )}
    </div>
  );
}

function PanelHeaderBar({ children }: { children: ReactNode }) {
  return <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">{children}</div>;
}

function Count({ value }: { value: number }) {
  return <span className="text-[10px] text-muted-foreground tabular-nums">{value}</span>;
}

/** 仅开发模式：切换内存 mock，便于没有真实编排时预览面板。数据源在页面加载时定下，所以要重新加载。 */
function DemoToggle() {
  const demo = isOrchestrationDemo();
  const label = demo ? '退出演示数据' : '使用演示数据';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            className={cn(demo && 'text-amber-600 dark:text-amber-400')}
          />
        }
        onClick={() => {
          setOrchestrationDemo(!demo);
          window.location.reload();
        }}
      >
        <FlaskConical />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}（开发模式，会重新加载页面）</TooltipContent>
    </Tooltip>
  );
}
