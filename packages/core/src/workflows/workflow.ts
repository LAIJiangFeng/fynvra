import { isValidRoleId } from '../roles/parseRole';
import { findWorkflowCycle, workflowAncestors, workflowTopologicalOrder } from './graph';

/** 节点在画布上的坐标（有限数，±{@link WORKFLOW_LIMITS.positionMax}）。 */
export interface WorkflowPosition {
  x: number;
  y: number;
}

/**
 * 工作流里的一个节点（界面称「节点」，沿用 step 命名）：由某个角色执行，
 * 所有上游（needs）都通过后才开始，失败时可退回到自身或某个祖先。
 */
export interface WorkflowStep {
  /** 工作流内唯一的 slug */
  id: string;
  /** 显示名，如「开发」，≤ 60 */
  name: string;
  /** 执行角色（不能是 tools: 'orchestrator' 的角色；保存时不强制，派发时检查） */
  roleId: string;
  /** 本步说明，会追加进任务书，≤ 4000 */
  instructions: string;
  /** 上游节点 id；空数组 = 起点。归一化输出总是带上 */
  needs: string[];
  /** 画布坐标；缺省时界面自动排版 */
  position?: WorkflowPosition;
  /** 本节点报告 failed 时退回的节点 id（自身或祖先）；缺省 = 整个任务失败 */
  onFail?: string;
}

/** 把多个角色组织成有向无环图，存于 userData/workflows.json；steps 按稳定拓扑序存放。 */
export interface Workflow {
  /** slug */
  id: string;
  /** ≤ 60 */
  name: string;
  /** ≤ 500 */
  description?: string;
  /** 1–20 个节点，按稳定拓扑序 */
  steps: WorkflowStep[];
  /** 回退上限，0–10，默认 3 */
  maxRounds: number;
}

export const WORKFLOW_LIMITS = {
  nameMax: 60,
  descriptionMax: 500,
  instructionsMax: 4000,
  stepsMin: 1,
  stepsMax: 20,
  /** position.x / position.y 的绝对值上限 */
  positionMax: 100000,
  maxRoundsMin: 0,
  maxRoundsMax: 10,
  /** workflows.json 里最多保存的工作流数 */
  workflowsMax: 50,
} as const;

export const DEFAULT_WORKFLOW_MAX_ROUNDS = 3;

/** {@link parseWorkflow} 的结果：成功带归一化后的工作流，失败带首个错误（含字段路径）。 */
export type ParseWorkflowResult = { ok: true; workflow: Workflow } | { ok: false; error: string };

/** 工作流 / 步骤 id 是否为合法 slug（与角色 id 同一规则）。 */
export function isValidWorkflowId(value: unknown): value is string {
  return isValidRoleId(value);
}

/**
 * 把任意输入（JSON 文件、IPC 入参）收窄为 {@link Workflow}，不抛异常。
 *
 * - 拒绝多余键；`null` 视同缺省。
 * - name / instructions 去首尾空白后不能为空；description 去首尾空白，空串视同缺省。
 * - 节点 id 在工作流内唯一；needs 引用已有节点、不重复、不指向自己，整张图无环。
 * - 兼容旧数据：没有任何节点带 needs 时按列表顺序转成线性链；否则缺 needs 的节点为起点。
 * - onFail 必须是节点自身或它的祖先。
 * - 输出的 steps 按稳定拓扑序（Kahn，同时可选时按输入顺序）。
 * - maxRounds 缺省为 {@link DEFAULT_WORKFLOW_MAX_ROUNDS}。
 * - roleId 只校验格式，角色是否存在、是否为编排角色由派发时检查。
 */
export function parseWorkflow(raw: unknown): ParseWorkflowResult {
  try {
    return { ok: true, workflow: readWorkflow(raw) };
  } catch (error) {
    if (error instanceof WorkflowInputError) return { ok: false, error: error.message };
    throw error;
  }
}

class WorkflowInputError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new WorkflowInputError(message);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: object, key: string): unknown {
  const value = Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
  return value === null ? undefined : value;
}

function checkKeys(record: object, allowed: readonly string[], path: string): void {
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  check(extra === undefined, `${path} has unknown key "${extra}"`);
}

const SLUG_RULE = 'a lowercase slug: a-z, 0-9 and "-", 1-64 chars, no leading or trailing "-"';

function requiredText(record: object, key: string, path: string, max: number): string {
  const value = field(record, key);
  check(typeof value === 'string' && value.trim() !== '', `${path}.${key} must be non-empty`);
  const text = value.trim();
  check(text.length <= max, `${path}.${key} must be at most ${max} characters`);
  return text;
}

const STEP_KEYS = ['id', 'name', 'roleId', 'instructions', 'needs', 'position', 'onFail'] as const;
const WORKFLOW_KEYS = ['id', 'name', 'description', 'steps', 'maxRounds'] as const;

function readPosition(raw: unknown, path: string): WorkflowPosition | undefined {
  if (raw === undefined) return undefined;
  check(isRecord(raw), `${path}.position must be an object`);
  checkKeys(raw, ['x', 'y'], `${path}.position`);
  const coordinate = (key: 'x' | 'y'): number => {
    const value = field(raw, key);
    check(
      typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= WORKFLOW_LIMITS.positionMax,
      `${path}.position.${key} must be a finite number within ±${WORKFLOW_LIMITS.positionMax}`
    );
    return value;
  };
  return { x: coordinate('x'), y: coordinate('y') };
}

/** 读出的节点；needs 缺省时为 undefined，由 readWorkflow 按兼容规则补齐。 */
type RawStep = Omit<WorkflowStep, 'needs'> & { needs?: string[] };

function readStep(raw: unknown, path: string): RawStep {
  check(isRecord(raw), `${path} must be an object`);
  checkKeys(raw, STEP_KEYS, path);
  const id = field(raw, 'id');
  check(isValidWorkflowId(id), `${path}.id must be ${SLUG_RULE}`);
  const name = requiredText(raw, 'name', path, WORKFLOW_LIMITS.nameMax);
  const roleId = field(raw, 'roleId');
  check(isValidRoleId(roleId), `${path}.roleId must be ${SLUG_RULE}`);
  const instructions = requiredText(raw, 'instructions', path, WORKFLOW_LIMITS.instructionsMax);
  const onFail = field(raw, 'onFail');
  check(onFail === undefined || typeof onFail === 'string', `${path}.onFail must be a step id`);
  const needs = field(raw, 'needs');
  check(
    needs === undefined || (Array.isArray(needs) && needs.every((n) => typeof n === 'string')),
    `${path}.needs must be an array of step ids`
  );
  const position = readPosition(field(raw, 'position'), path);
  return {
    id,
    name,
    roleId,
    instructions,
    ...(needs === undefined ? {} : { needs: [...needs] }),
    ...(position === undefined ? {} : { position }),
    ...(onFail === undefined ? {} : { onFail }),
  };
}

/** 补齐 needs、校验引用与环、onFail 只能指向自身或祖先，按稳定拓扑序输出。 */
function readGraph(rawSteps: RawStep[]): WorkflowStep[] {
  const ids = new Set<string>();
  for (const [index, step] of rawSteps.entries()) {
    check(!ids.has(step.id), `workflow.steps[${index}].id "${step.id}" is duplicated`);
    ids.add(step.id);
  }
  const legacy = rawSteps.every((step) => step.needs === undefined);
  const steps: WorkflowStep[] = rawSteps.map(
    ({ id, name, roleId, instructions, needs, position, onFail }, index) => {
      const previous = rawSteps[index - 1];
      return {
        id,
        name,
        roleId,
        instructions,
        needs: legacy ? (previous ? [previous.id] : []) : (needs ?? []),
        ...(position === undefined ? {} : { position }),
        ...(onFail === undefined ? {} : { onFail }),
      };
    }
  );
  for (const [index, step] of steps.entries()) {
    const path = `workflow.steps[${index}].needs`;
    const seen = new Set<string>();
    for (const need of step.needs) {
      check(need !== step.id, `${path} must not contain the step itself ("${need}")`);
      check(ids.has(need), `${path} "${need}" does not match any step id`);
      check(!seen.has(need), `${path} "${need}" is duplicated`);
      seen.add(need);
    }
  }
  const cycle = findWorkflowCycle(steps);
  check(
    cycle === undefined,
    `workflow.steps must not form a cycle: ${[...(cycle ?? []), cycle?.[0]].join(' → ')}`
  );
  for (const [index, step] of steps.entries()) {
    if (step.onFail === undefined) continue;
    check(
      ids.has(step.onFail),
      `workflow.steps[${index}].onFail "${step.onFail}" does not match any step id`
    );
    check(
      step.onFail === step.id || workflowAncestors(steps, step.id).has(step.onFail),
      `workflow.steps[${index}].onFail "${step.onFail}" must be the step itself or one of its upstream steps`
    );
  }
  const order = workflowTopologicalOrder(steps);
  check(order !== undefined, 'workflow.steps must not form a cycle');
  return order;
}

function readWorkflow(raw: unknown): Workflow {
  check(isRecord(raw), 'workflow must be an object');
  checkKeys(raw, WORKFLOW_KEYS, 'workflow');
  const id = field(raw, 'id');
  check(isValidWorkflowId(id), `workflow.id must be ${SLUG_RULE}`);
  const name = requiredText(raw, 'name', 'workflow', WORKFLOW_LIMITS.nameMax);

  const rawDescription = field(raw, 'description');
  check(
    rawDescription === undefined || typeof rawDescription === 'string',
    'workflow.description must be a string'
  );
  const description = rawDescription?.trim() || undefined;
  check(
    description === undefined || description.length <= WORKFLOW_LIMITS.descriptionMax,
    `workflow.description must be at most ${WORKFLOW_LIMITS.descriptionMax} characters`
  );

  const rawSteps = field(raw, 'steps');
  check(Array.isArray(rawSteps), 'workflow.steps must be an array');
  check(
    rawSteps.length >= WORKFLOW_LIMITS.stepsMin && rawSteps.length <= WORKFLOW_LIMITS.stepsMax,
    `workflow.steps must have ${WORKFLOW_LIMITS.stepsMin}-${WORKFLOW_LIMITS.stepsMax} steps`
  );
  const steps = readGraph(
    rawSteps.map((step, index) => readStep(step, `workflow.steps[${index}]`))
  );

  const rawMaxRounds = field(raw, 'maxRounds');
  const maxRounds = rawMaxRounds === undefined ? DEFAULT_WORKFLOW_MAX_ROUNDS : rawMaxRounds;
  check(
    typeof maxRounds === 'number' &&
      Number.isInteger(maxRounds) &&
      maxRounds >= WORKFLOW_LIMITS.maxRoundsMin &&
      maxRounds <= WORKFLOW_LIMITS.maxRoundsMax,
    `workflow.maxRounds must be an integer ${WORKFLOW_LIMITS.maxRoundsMin}-${WORKFLOW_LIMITS.maxRoundsMax}`
  );

  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    steps,
    maxRounds,
  };
}
