import { isValidRoleId } from '../roles/parseRole';

/** 工作流里的一步：由某个角色执行，失败时可退回到某一步。 */
export interface WorkflowStep {
  /** 工作流内唯一的 slug */
  id: string;
  /** 显示名，如「开发」，≤ 60 */
  name: string;
  /** 执行角色（不能是 tools: 'orchestrator' 的角色；保存时不强制，派发时检查） */
  roleId: string;
  /** 本步说明，会追加进任务书，≤ 4000 */
  instructions: string;
  /** 本步报告 failed 时退回的步骤 id；缺省 = 整个任务失败 */
  onFail?: string;
}

/** 把多个角色串成有顺序的步骤，存于 userData/workflows.json。 */
export interface Workflow {
  /** slug */
  id: string;
  /** ≤ 60 */
  name: string;
  /** ≤ 500 */
  description?: string;
  /** 1–10 步 */
  steps: WorkflowStep[];
  /** 回退上限，0–10，默认 3 */
  maxRounds: number;
}

export const WORKFLOW_LIMITS = {
  nameMax: 60,
  descriptionMax: 500,
  instructionsMax: 4000,
  stepsMin: 1,
  stepsMax: 10,
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
 * - 步骤 id 在工作流内唯一；onFail 必须指向本工作流里已有的步骤 id（可指向自己）。
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

const STEP_KEYS = ['id', 'name', 'roleId', 'instructions', 'onFail'] as const;
const WORKFLOW_KEYS = ['id', 'name', 'description', 'steps', 'maxRounds'] as const;

function readStep(raw: unknown, path: string): WorkflowStep {
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
  return { id, name, roleId, instructions, ...(onFail === undefined ? {} : { onFail }) };
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
  const steps = rawSteps.map((step, index) => readStep(step, `workflow.steps[${index}]`));
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    check(!ids.has(step.id), `workflow.steps[${index}].id "${step.id}" is duplicated`);
    ids.add(step.id);
  }
  for (const [index, step] of steps.entries()) {
    check(
      step.onFail === undefined || ids.has(step.onFail),
      `workflow.steps[${index}].onFail "${step.onFail}" does not match any step id`
    );
  }

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
