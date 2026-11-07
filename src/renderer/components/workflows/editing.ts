import { type WorkflowStep, workflowAncestors } from '@fynvra/core';
import { NODE_HEIGHT, NODE_WIDTH, resolvePositions } from './layout';
import type { WorkflowEdgeRef } from './WorkflowGraph';

/**
 * 画布编辑器对节点列表的纯函数操作。都返回新数组，不改入参。
 * 删除节点 / 连线后，不再是自身或祖先的 onFail 会被清掉（cleared 计数供提示）。
 */

/** 缺 position 的节点用 dagre 自动排版的结果补齐（编辑器里节点总是带坐标）。 */
export function withPositions(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const positions = resolvePositions(steps);
  return steps.map((step) =>
    step.position ? step : { ...step, position: positions[step.id] ?? { x: 0, y: 0 } }
  );
}

/** 清掉失效的 onFail（指向不存在的节点，或已不是自身 / 祖先）。 */
export function pruneFailTargets(steps: readonly WorkflowStep[]): {
  steps: WorkflowStep[];
  cleared: number;
} {
  let cleared = 0;
  const next = steps.map((step) => {
    if (!step.onFail || step.onFail === step.id) return step;
    if (workflowAncestors(steps, step.id).has(step.onFail)) return step;
    cleared += 1;
    const { onFail: _onFail, ...rest } = step;
    return rest;
  });
  return { steps: next, cleared };
}

/** 删除节点，并清理其他节点 needs / onFail 里对它们的引用。 */
export function removeNodes(
  steps: readonly WorkflowStep[],
  ids: readonly string[]
): { steps: WorkflowStep[]; cleared: number } {
  const removed = new Set(ids);
  const kept = steps
    .filter((step) => !removed.has(step.id))
    .map((step) => ({ ...step, needs: step.needs.filter((need) => !removed.has(need)) }));
  return pruneFailTargets(kept);
}

/** 删除连线：依赖边从下游的 needs 里移除；失败退回边清掉 source 的 onFail。 */
export function removeEdges(
  steps: readonly WorkflowStep[],
  edges: readonly WorkflowEdgeRef[]
): { steps: WorkflowStep[]; cleared: number } {
  const next = steps.map((step) => {
    let current = step;
    for (const edge of edges) {
      if (edge.kind === 'needs' && edge.target === current.id) {
        current = { ...current, needs: current.needs.filter((need) => need !== edge.source) };
      } else if (edge.kind === 'fail' && edge.source === current.id) {
        const { onFail: _onFail, ...rest } = current;
        current = rest;
      }
    }
    return current;
  });
  return pruneFailTargets(next);
}

export type ConnectResult =
  | { ok: true; steps: WorkflowStep[] }
  | { ok: false; reason: 'self' | 'duplicate' | 'cycle' | 'missing' };

/** 建立依赖 source → target（把 source 加进 target 的 needs）；自连、重复、成环都拒绝。 */
export function connectNodes(
  steps: readonly WorkflowStep[],
  source: string,
  target: string
): ConnectResult {
  if (source === target) return { ok: false, reason: 'self' };
  const to = steps.find((step) => step.id === target);
  if (!to || !steps.some((step) => step.id === source)) return { ok: false, reason: 'missing' };
  if (to.needs.includes(source)) return { ok: false, reason: 'duplicate' };
  // target 已经是 source 的祖先（或经其他路径可达）时，新边会形成环
  if (workflowAncestors(steps, source).has(target)) return { ok: false, reason: 'cycle' };
  return {
    ok: true,
    steps: steps.map((step) =>
      step.id === target ? { ...step, needs: [...step.needs, source] } : step
    ),
  };
}

/** 新节点 id：step-N，不与已有 id 重复。 */
export function nextNodeId(steps: readonly WorkflowStep[]): string {
  const taken = new Set(steps.map((step) => step.id));
  let n = steps.length + 1;
  while (taken.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

/** 新节点的位置：放在锚点（选中节点，否则最右边的节点）右侧，与已有节点重叠时往下挪。 */
export function placeNewNode(
  steps: readonly WorkflowStep[],
  anchorId: string | null
): { x: number; y: number } {
  const placed = steps.filter((step) => step.position);
  const anchor =
    placed.find((step) => step.id === anchorId) ??
    placed.reduce<WorkflowStep | undefined>(
      (best, step) => (!best || (step.position?.x ?? 0) > (best.position?.x ?? 0) ? step : best),
      undefined
    );
  if (!anchor?.position) return { x: 0, y: 0 };
  const x = anchor.position.x + NODE_WIDTH + 72;
  let y = anchor.position.y;
  const overlaps = (yy: number) =>
    placed.some(
      (step) =>
        Math.abs((step.position?.x ?? 0) - x) < NODE_WIDTH &&
        Math.abs((step.position?.y ?? 0) - yy) < NODE_HEIGHT + 12
    );
  for (let i = 0; i < 40 && overlaps(y); i += 1) y += NODE_HEIGHT + 24;
  return { x: Math.round(x), y: Math.round(y) };
}
