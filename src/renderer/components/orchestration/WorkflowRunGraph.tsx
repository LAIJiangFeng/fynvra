import type { Dispatch, TaskWorkflow, TaskWorkflowNodeStatus } from '@fynvra/core';
import { MousePointerClick } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { WorkflowGraph } from '@/components/workflows/WorkflowGraph';
import { useT } from '@/i18n/I18nProvider';
import { useRolesStore } from '@/stores/roles';
import { SectionTitle, workflowNodeStatuses, workflowOverallStatus } from './common';

/** 节点详情里总结摘要的最大字数。 */
const SUMMARY_CHARS = 240;

const OVERALL_TONE: Record<TaskWorkflowNodeStatus, string> = {
  waiting: 'text-muted-foreground',
  running: 'text-sky-700 dark:text-sky-300',
  passed: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 任务抽屉里的只读流程图：节点按本轮运行状态着色；悬停或选中显示节点详情；
 * 点击有尝试（当前或最近一次）的节点，在抽屉里查看该尝试的 worker 输出。
 * 旧快照缺少运行状态时全部按「等待」显示。
 */
export function WorkflowRunGraph({
  workflow,
  dispatches,
  selectedNodeId,
  onOpenOutput,
}: {
  workflow: TaskWorkflow;
  dispatches: readonly Dispatch[];
  /** 当前在抽屉里查看输出的节点 */
  selectedNodeId: string | null;
  onOpenOutput: (nodeId: string, dispatchId: string) => void;
}) {
  const t = useT();
  const roles = useRolesStore((state) => state.roles);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const history = Array.isArray(workflow.history) ? workflow.history : [];
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];

  const roleNames = useMemo(
    () => Object.fromEntries(roles.map((role) => [role.id, role.name])),
    [roles]
  );
  const statuses = useMemo(() => workflowNodeStatuses(workflow), [workflow]);
  const overall = workflowOverallStatus(workflow);

  /** 节点当前的尝试，没有时取历史里最近一次；只认本任务已存在的尝试。 */
  const dispatchOf = (nodeId: string): string | undefined => {
    const known = new Set(dispatches.map((dispatch) => dispatch.id));
    const current = nodes.find((node) => node.id === nodeId)?.dispatchId;
    if (current && known.has(current)) return current;
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index];
      if (entry?.nodeId === nodeId && known.has(entry.dispatchId)) return entry.dispatchId;
    }
    return undefined;
  };

  if (steps.length === 0) return null;

  const activeId = hoveredId ?? selectedNodeId;
  const activeStep = activeId ? steps.find((step) => step.id === activeId) : undefined;
  let details: ReactNode = (
    <p className="flex items-center gap-1 text-muted-foreground">
      <MousePointerClick className="size-3 shrink-0" />
      {t('orchestration.workflow.graphHint')}
    </p>
  );
  if (activeStep) {
    const status = statuses[activeStep.id] ?? 'waiting';
    const node = nodes.find((candidate) => candidate.id === activeStep.id);
    const lastEntry = [...history].reverse().find((entry) => entry.nodeId === activeStep.id);
    const lastDispatch = dispatches.find((dispatch) => dispatch.id === node?.dispatchId);
    const summary = lastEntry?.summary || node?.failure || lastDispatch?.summary || '';
    const dispatchId = dispatchOf(activeStep.id);
    details = (
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="truncate font-medium">
            {activeStep.name.trim() || t('settings.workflows.graph.untitled')}
          </span>
          <span className="text-muted-foreground">
            {roleNames[activeStep.roleId] ?? activeStep.roleId}
          </span>
          <span className={OVERALL_TONE[status]}>
            {t(`settings.workflows.graph.status.${status}`)}
          </span>
        </p>
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">
          {summary ? truncate(summary, SUMMARY_CHARS) : t('orchestration.workflow.noSummary')}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {t(dispatchId ? 'orchestration.workflow.clickToView' : 'orchestration.workflow.notRun')}
        </p>
      </div>
    );
  }

  const rounds = Number.isFinite(workflow.rounds) ? workflow.rounds : 0;
  const maxRounds = Number.isFinite(workflow.maxRounds) ? workflow.maxRounds : 0;

  return (
    <section aria-label={t('orchestration.workflow.graph')}>
      <SectionTitle
        aside={
          <span className="flex items-center gap-2 text-[11px] tabular-nums">
            <span className={OVERALL_TONE[overall]}>
              {t('orchestration.workflow.overall', {
                state: t(`settings.workflows.graph.status.${overall}`),
              })}
            </span>
            <span className="text-muted-foreground">
              {t('orchestration.workflow.rounds', { rounds, max: maxRounds })}
            </span>
          </span>
        }
      >
        {t('orchestration.workflow.graph')}
      </SectionTitle>
      <div className="h-64 overflow-hidden rounded-md border bg-card">
        <WorkflowGraph
          steps={steps}
          roleNames={roleNames}
          statuses={statuses}
          selectedId={selectedNodeId}
          onNodeHover={setHoveredId}
          onNodeClick={(nodeId) => {
            const dispatchId = dispatchOf(nodeId);
            if (dispatchId) onOpenOutput(nodeId, dispatchId);
          }}
        />
      </div>
      <div className="mt-1.5 min-h-12 rounded-md border bg-card px-2.5 py-1.5 text-xs">
        {details}
      </div>
    </section>
  );
}
