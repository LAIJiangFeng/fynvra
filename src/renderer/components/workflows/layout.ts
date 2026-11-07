import { Graph, layout } from '@dagrejs/dagre';
import { WORKFLOW_LIMITS, type WorkflowPosition, type WorkflowStep } from '@fynvra/core';

/** 节点卡片的固定尺寸（dagre 排版与画布渲染共用）。 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;

type LayoutInput = Pick<WorkflowStep, 'id' | 'needs'>;

/** dagre 从左到右自动排版，返回每个节点左上角坐标（取整）。needs 里不存在的 id 忽略。 */
export function autoLayout(steps: readonly LayoutInput[]): Record<string, WorkflowPosition> {
  const graph = new Graph<object, { width: number; height: number; x?: number; y?: number }>();
  graph.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 72, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) graph.setNode(step.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const step of steps) {
    for (const need of step.needs) if (ids.has(need)) graph.setEdge(need, step.id);
  }
  layout(graph);
  const positions: Record<string, WorkflowPosition> = {};
  for (const step of steps) {
    const node = graph.node(step.id);
    positions[step.id] = clampPosition({
      x: (node?.x ?? 0) - NODE_WIDTH / 2,
      y: (node?.y ?? 0) - NODE_HEIGHT / 2,
    });
  }
  return positions;
}

/** 取整并限制在模型允许的范围内（±positionMax）。 */
export function clampPosition({ x, y }: WorkflowPosition): WorkflowPosition {
  const max = WORKFLOW_LIMITS.positionMax;
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.max(-max, Math.min(max, Math.round(value))) : 0;
  return { x: clamp(x), y: clamp(y) };
}

/** 节点有 position 用它，缺失的用 dagre 自动排版的结果补齐。 */
export function resolvePositions(
  steps: readonly (LayoutInput & Pick<WorkflowStep, 'position'>)[]
): Record<string, WorkflowPosition> {
  const missing = steps.some((step) => !step.position);
  const auto = missing ? autoLayout(steps) : {};
  const positions: Record<string, WorkflowPosition> = {};
  for (const step of steps) {
    positions[step.id] = step.position ?? auto[step.id] ?? { x: 0, y: 0 };
  }
  return positions;
}
