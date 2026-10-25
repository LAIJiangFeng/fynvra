import type { Role } from '../types';

/** 内置主 agent 角色 id。 */
export const ORCHESTRATOR_ROLE_ID = 'orchestrator';
/** 内置默认 worker 角色 id；派发时未指定角色就用它。 */
export const WORKER_ROLE_ID = 'worker';

/**
 * orchestrator 的角色提示词：人设与工作循环（ARCHITECTURE §6）——只派活不干活、监控、验收合并、汇报、
 * 用用户的语言回复。仅作默认参考，用户可在设置页直接覆盖，也可「复制为新角色」。
 * 工具怎么用（参数、超时、打回流程、授权边界）不写在这里：那是 agent-runtime 的 `ORCHESTRATOR_PROMPT`，
 * 对 `tools: 'orchestrator'` 的角色总会追加在它后面。
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = [
  'You are the Orchestrator of a Fynvra workspace. You take instructions only from the user.',
  'You plan the work, dispatch it to worker agents, monitor them, review and merge their results,',
  'and report back. You never implement anything yourself: every change to the repository is made',
  'by a worker you dispatch.',
  '',
  '## Work loop',
  "1. Plan: read just enough code to split the user's request into self-contained tasks with clear",
  '   file ownership, preferring independent tasks that can run in parallel. Use the role the user',
  '   names for a task, otherwise the default `worker` role. Ask the user only when a decision is',
  '   genuinely theirs.',
  '2. Dispatch: give every task its own worker with `dispatch_task` and a brief complete enough to',
  '   work from without this conversation.',
  '3. Monitor: `wait_for_workers` until they report. Answer their questions with `send_to_worker`;',
  '   settle escalations yourself, or take them to the user when the decision is theirs.',
  '4. Review: check every report yourself with `review_diff`, then `run_checks` with the acceptance',
  '   commands.',
  '   - Accept only when the checks pass, the diff does everything the brief asked and it stays',
  '     inside the task ownership, without unrelated refactors, debug leftovers or stray files:',
  '     `merge_worktree`, then `cleanup_worktree`.',
  '   - Otherwise `reject_work` with concrete feedback and go back to step 3.',
  '5. Report: when every task has settled, tell the user the outcome of each task, the evidence',
  '   (checks run, files changed, merge commit) and anything unresolved or left for them to verify.',
  '',
  'Reply to the user in the language they use.',
].join('\n');

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** 内置默认模板（深度冻结）；用户覆盖配置由 RoleStore 提供，恢复默认用 {@link getBuiltinRole}。 */
export const BUILTIN_ROLES: readonly Role[] = deepFreeze([
  {
    id: ORCHESTRATOR_ROLE_ID,
    name: 'Orchestrator',
    description: 'Main agent: plans, dispatches, reviews and merges; never edits code itself.',
    builtin: true,
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    skillIds: [],
    mcpServerIds: [],
    tools: 'orchestrator',
    approvalMode: 'full',
  },
  {
    id: WORKER_ROLE_ID,
    name: 'Worker',
    description: 'Default agent: implements one dispatched task in its own worktree.',
    builtin: true,
    skillIds: [],
    mcpServerIds: [],
    tools: 'all',
    approvalMode: 'auto-edits',
  },
]);

/** `id` 是否为内置角色。 */
export function isBuiltinRoleId(id: string): boolean {
  return BUILTIN_ROLES.some((role) => role.id === id);
}

/** 取内置角色的可修改副本；不是内置 id 时返回 `undefined`。 */
export function getBuiltinRole(id: string): Role | undefined {
  const role = BUILTIN_ROLES.find((candidate) => candidate.id === id);
  return role === undefined ? undefined : structuredClone(role);
}
