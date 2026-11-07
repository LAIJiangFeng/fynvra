import type { WorkflowStep } from './workflow';

/**
 * 工作流图的纯函数工具（W2 引擎、W3 画布、W4 进度图共用）。
 *
 * 入参只需要节点的 `id` 与 `needs`；`needs` 里引用不存在的 id 一律忽略。
 * 返回的 id 列表都按入参 steps 的顺序排列，结果稳定。
 */
export type WorkflowGraphNode = Pick<WorkflowStep, 'id' | 'needs'>;

/**
 * 稳定拓扑序（Kahn）：同时可选的节点按入参顺序取。图里有环时返回 undefined。
 */
export function workflowTopologicalOrder<T extends WorkflowGraphNode>(
  steps: readonly T[]
): T[] | undefined {
  const ids = new Set(steps.map((step) => step.id));
  const remaining = new Map(
    steps.map((step) => [step.id, new Set(step.needs.filter((id) => ids.has(id)))])
  );
  const order: T[] = [];
  const done = new Set<string>();
  while (order.length < steps.length) {
    const next = steps.find((step) => !done.has(step.id) && remaining.get(step.id)?.size === 0);
    if (!next) return undefined;
    order.push(next);
    done.add(next.id);
    for (const pending of remaining.values()) pending.delete(next.id);
  }
  return order;
}

/** 找出一个环，按依赖方向列出环上的节点 id（首尾不重复）；无环时返回 undefined。 */
export function findWorkflowCycle(steps: readonly WorkflowGraphNode[]): string[] | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === 'done') return undefined;
    if (mark === 'visiting') return path.slice(path.indexOf(id));
    state.set(id, 'visiting');
    path.push(id);
    for (const parent of byId.get(id)?.needs ?? []) {
      if (!byId.has(parent)) continue;
      const cycle = visit(parent);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle.reverse();
  }
  return undefined;
}

/** 直接上游节点（needs 中存在的那些）。 */
export function workflowParents(steps: readonly WorkflowGraphNode[], id: string): string[] {
  const needs = new Set(steps.find((step) => step.id === id)?.needs ?? []);
  return steps.filter((step) => needs.has(step.id)).map((step) => step.id);
}

/** 直接下游节点（needs 里包含 id 的节点）。 */
export function workflowChildren(steps: readonly WorkflowGraphNode[], id: string): string[] {
  return steps.filter((step) => step.needs.includes(id)).map((step) => step.id);
}

function reach(
  steps: readonly WorkflowGraphNode[],
  id: string,
  next: (steps: readonly WorkflowGraphNode[], id: string) => string[]
): Set<string> {
  const found = new Set<string>();
  const queue = next(steps, id);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (found.has(current)) continue;
    found.add(current);
    queue.push(...next(steps, current));
  }
  found.delete(id);
  return found;
}

/** 全部祖先：经 needs 可传递到达的上游节点（不含自身）。 */
export function workflowAncestors(steps: readonly WorkflowGraphNode[], id: string): Set<string> {
  return reach(steps, id, workflowParents);
}

/** 全部后代：经 needs 反向可传递到达的下游节点（不含自身）。 */
export function workflowDescendants(steps: readonly WorkflowGraphNode[], id: string): Set<string> {
  return reach(steps, id, workflowChildren);
}

/** 起点：没有（有效）上游的节点。 */
export function workflowRoots(steps: readonly WorkflowGraphNode[]): string[] {
  return steps
    .filter((step) => workflowParents(steps, step.id).length === 0)
    .map((step) => step.id);
}

/** 终点：没有下游的节点。 */
export function workflowSinks(steps: readonly WorkflowGraphNode[]): string[] {
  return steps
    .filter((step) => workflowChildren(steps, step.id).length === 0)
    .map((step) => step.id);
}

/**
 * 按最长路径分层：第 0 层是起点，其余节点的层号 = 上游最大层号 + 1。
 * 每层内按入参顺序。有环时返回 undefined。
 */
export function workflowLevels(steps: readonly WorkflowGraphNode[]): string[][] | undefined {
  const order = workflowTopologicalOrder(steps);
  if (!order) return undefined;
  const level = new Map<string, number>();
  for (const step of order) {
    const parents = workflowParents(steps, step.id);
    level.set(
      step.id,
      parents.length === 0 ? 0 : Math.max(...parents.map((p) => level.get(p) ?? 0)) + 1
    );
  }
  const levels: string[][] = [];
  for (const step of steps) {
    const index = level.get(step.id) ?? 0;
    const row = levels[index] ?? [];
    row.push(step.id);
    levels[index] = row;
  }
  return levels;
}

/**
 * 文字摘要。能按层表达时（每层的每个节点恰好依赖上一层的全部节点）写成
 * `开发 → (测试 ‖ 安全审查) → 验收`；只有一层时不加括号，如 `A ‖ B`。
 * 否则退化为按拓扑序逐个列出：`开发; 测试 ← 开发; 验收 ← 测试 + 安全审查`。
 * 有环（未经 parseWorkflow 的输入）时按入参顺序用 ` → ` 连接。
 */
export function summarizeWorkflow<T extends WorkflowGraphNode & Pick<WorkflowStep, 'name'>>(
  steps: readonly T[],
  label: (step: T) => string = (step) => step.name
): string {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const text = (id: string) => {
    const step = byId.get(id);
    return step ? label(step) : id;
  };
  const levels = workflowLevels(steps);
  if (!levels) return steps.map(label).join(' → ');
  const layered = levels.every(
    (ids, index) =>
      index === 0 ||
      ids.every((id) => {
        const parents = workflowParents(steps, id);
        const previous = levels[index - 1] ?? [];
        return parents.length === previous.length && previous.every((p) => parents.includes(p));
      })
  );
  if (layered) {
    const group = (ids: string[]) => {
      const body = ids.map(text).join(' ‖ ');
      return ids.length > 1 && levels.length > 1 ? `(${body})` : body;
    };
    return levels.map(group).join(' → ');
  }
  const order = workflowTopologicalOrder(steps) ?? [...steps];
  return order
    .map((step) => {
      const parents = workflowParents(steps, step.id);
      return parents.length === 0
        ? label(step)
        : `${label(step)} ← ${parents.map(text).join(' + ')}`;
    })
    .join('; ');
}
