import { type Static, StringEnum, type TSchema, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  type Dispatch,
  type Message,
  normalizeThinkingLevel,
  type Role,
  type Task,
  THINKING_LEVELS,
} from '@fynvra/core';
import type {
  CleanupWorktreeOutput,
  DispatchRef,
  DispatchTaskInput,
  MergeWorktreeOutput,
  OrchestrationHost,
  OrchestrationToolName,
  ReadWorkerOutputInput,
  RejectWorkInput,
  ReviewDiffOutput,
  RunChecksInput,
  SendToWorkerInput,
  WaitForWorkersInput,
  WaitForWorkersOutput,
  WorkerEntry,
} from '../host';
import {
  type ArgRecord,
  asRecord,
  clamp,
  compact,
  integerish,
  type Parsed,
  pick,
  requiredText,
  stringList,
  trimmed,
} from './args';
import {
  inlineCode as code,
  errorResult,
  fence,
  safely,
  type ToolResult,
  textResult,
  truncateHeadChars,
  truncateTailChars,
} from './result';

export const WAIT_TIMEOUT_MIN_MS = 1_000;
export const WAIT_TIMEOUT_MAX_MS = 900_000;
export const WAIT_TIMEOUT_DEFAULT_MS = 300_000;
/** read_worker_output 每页最多返回的字符数 */
export const WORKER_OUTPUT_PAGE_CHARS = 20_000;
export const DIFF_MAX_CHARS = 40_000;
/** run_checks 保留的输出尾部字符数 */
export const CHECK_OUTPUT_MAX_CHARS = 12_000;
export const DEFAULT_ROLE_ID = 'worker';

const MESSAGE_BODY_MAX_CHARS = 6_000;
const TITLE_MAX_CHARS = 120;
const MAX_LISTED_FILES = 50;

export type RoleOption = Pick<Role, 'id' | 'name' | 'description'>;

export interface OrchestrationToolsOptions {
  /** 可派发的角色。提供时 `role` 参数是枚举，并支持按显示名（不区分大小写）匹配 */
  roles?: readonly RoleOption[];
}

/**
 * orchestrator 角色的编排工具，与 {@link OrchestrationHost} 方法一一对应。
 *
 * 每个工具都是「先归一化再校验」：`prepareArguments` 在 pi 的 schema 校验前修正参数形状
 * （别名、trim、clamp、默认值），execute 再做语义校验后调用 Host。execute 永不抛异常。
 */
export function createOrchestrationTools(
  host: OrchestrationHost,
  options: OrchestrationToolsOptions = {}
): ToolDefinition[] {
  const roles = options.roles ?? [];
  return [
    tool({
      name: 'dispatch_task',
      label: 'Dispatch task',
      description:
        'Create a task and start a worker agent on it in a fresh git worktree (branch fynvra/<slug>); ' +
        'in a workspace without git the worker edits the workspace directory in place instead. ' +
        "The spec is the worker's entire context, so write it as a complete brief. Returns task_id and " +
        'dispatch_id. Workers run in the background; Fynvra wakes you automatically when they report, ' +
        'and wait_for_workers can also collect their results.',
      promptSnippet: 'Start a worker in its own git worktree on a task brief',
      promptGuidelines: [
        'Delegate every code change with dispatch_task; never edit files or run write commands yourself.',
        'Independent tasks can be dispatched back to back so their workers run in parallel; use depends_on only for real ordering constraints.',
      ],
      parameters: dispatchTaskSchema(roles),
      executionMode: 'sequential',
      normalize: (raw) => normalizeDispatchArgs(raw, roles),
      run: async (params, signal) => {
        const input = parseDispatchArgs(params, roles);
        if (!input.ok) return errorResult('dispatch_task', input.error);
        const result = await host.dispatchTask(input.value, signal);
        if (!result.ok) return errorResult('dispatch_task', result.error);
        return textResult(formatDispatched(result.task, result.dispatch), result);
      },
    }),
    tool({
      name: 'list_workers',
      label: 'List workers',
      description:
        'List every task of this run with its status, role, dispatch_id, branch and, once settled, the outcome reported by the worker.',
      promptSnippet: 'Show all tasks with status, dispatch_id and branch',
      parameters: Type.Object({}, { additionalProperties: false }),
      normalize: () => ({}),
      run: async (_params, signal) => {
        const result = await host.listWorkers(signal);
        if (!result.ok) return errorResult('list_workers', result.error);
        return textResult(formatWorkers(result.workers), result);
      },
    }),
    tool({
      name: 'wait_for_workers',
      label: 'Wait for workers',
      description:
        "Block until workers report. until='all' (default) returns when every running worker has settled, " +
        "until='any' on the first worker_done. Always returns early when a worker asks a question or escalates. " +
        `timeout_ms is clamped to [${WAIT_TIMEOUT_MIN_MS}, ${WAIT_TIMEOUT_MAX_MS}] (default ${WAIT_TIMEOUT_DEFAULT_MS}); ` +
        'a timeout is not a failure and never stops a worker.',
      promptSnippet: 'Block until workers report done, ask a question or escalate',
      promptGuidelines: [
        'You know nothing about a worker result until its worker_done message arrives; never predict or report results before that.',
      ],
      parameters: Type.Object(
        {
          timeout_ms: Type.Optional(
            Type.Integer({
              minimum: WAIT_TIMEOUT_MIN_MS,
              maximum: WAIT_TIMEOUT_MAX_MS,
              description: `Maximum wait in milliseconds. Default ${WAIT_TIMEOUT_DEFAULT_MS}; values outside [${WAIT_TIMEOUT_MIN_MS}, ${WAIT_TIMEOUT_MAX_MS}] are clamped.`,
            })
          ),
          until: Type.Optional(
            StringEnum(['any', 'all'] as const, {
              description:
                "'all' (default): return when every running worker has settled. 'any': return on the first worker_done.",
              default: 'all',
            })
          ),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      normalize: normalizeWaitArgs,
      run: async (params, signal) => {
        const input = parseWaitArgs(params);
        if (!input.ok) return errorResult('wait_for_workers', input.error);
        const result = await host.waitForWorkers(input.value, signal);
        if (!result.ok) return errorResult('wait_for_workers', result.error);
        return textResult(formatWait(result, input.value.timeoutMs), result);
      },
    }),
    tool({
      name: 'read_worker_output',
      label: 'Read worker output',
      description:
        "Read a worker's live output (its messages and tool activity) starting at a character cursor. " +
        `Returns at most ${WORKER_OUTPUT_PAGE_CHARS} characters per call; continue with the cursor named in the result.`,
      promptSnippet: "Page through a worker's live output with a cursor",
      parameters: Type.Object(
        {
          dispatch_id: dispatchIdParam(),
          cursor: Type.Optional(
            Type.Integer({
              minimum: 0,
              description:
                'Character offset to continue from, as given by the previous result. Default 0.',
            })
          ),
        },
        { additionalProperties: false }
      ),
      normalize: normalizeReadArgs,
      run: async (params, signal) => {
        const input = parseReadArgs(params);
        if (!input.ok) return errorResult('read_worker_output', input.error);
        const result = await host.readWorkerOutput(input.value, signal);
        if (!result.ok) return errorResult('read_worker_output', result.error);
        return textResult(formatWorkerOutput(input.value, result), result);
      },
    }),
    tool({
      name: 'send_to_worker',
      label: 'Send to worker',
      description:
        'Send a message to a worker. If the worker is blocked on ask_coordinator this is the reply; otherwise it is delivered as an instruction.',
      promptSnippet: 'Answer a worker question or send it an instruction',
      parameters: Type.Object(
        {
          dispatch_id: dispatchIdParam(),
          body: Type.String({
            description:
              "Message text. Answers the worker's pending question if it has one; otherwise it is delivered as an instruction.",
          }),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      normalize: (raw) => normalizeTextArgs(raw, 'body'),
      run: async (params, signal) => {
        const input = parseTextArgs(params, 'body');
        if (!input.ok) return errorResult('send_to_worker', input.error);
        const payload: SendToWorkerInput = {
          dispatchId: input.value.dispatchId,
          body: input.value.text,
        };
        const result = await host.sendToWorker(payload, signal);
        if (!result.ok) return errorResult('send_to_worker', result.error);
        return textResult(
          [
            `## Message sent · dispatch ${code(payload.dispatchId)}`,
            `- message_id: ${code(result.messageId)}`,
            `- delivered as: ${result.type === 'reply' ? "reply (answers the worker's pending question)" : result.type}`,
          ].join('\n'),
          result
        );
      },
    }),
    tool({
      name: 'review_diff',
      label: 'Review diff',
      description:
        "Show a worker's changes relative to its base commit: changed files, diffstat and the diff " +
        `(truncated after ${DIFF_MAX_CHARS} characters). Without git there is no diff; it lists the files the worker reported instead.`,
      promptSnippet: "Show a worker's changed files and diff",
      parameters: dispatchRefSchema(),
      normalize: normalizeRefArgs,
      run: async (params, signal) => {
        const input = parseRefArgs(params);
        if (!input.ok) return errorResult('review_diff', input.error);
        const result = await host.reviewDiff(input.value, signal);
        if (!result.ok) return errorResult('review_diff', result.error);
        return textResult(formatDiff(input.value.dispatchId, result), result);
      },
    }),
    tool({
      name: 'run_checks',
      label: 'Run checks',
      description:
        "Run a verification command in a worker's worktree (the workspace directory when there is no git) and return its exit code and the tail of its output. " +
        "Verify work yourself with it instead of trusting the worker's report.",
      promptSnippet: "Run a verification command in a worker's worktree",
      parameters: Type.Object(
        {
          dispatch_id: dispatchIdParam(),
          command: Type.String({
            description:
              "Verification command run in the worker's worktree, e.g. 'pnpm typecheck && pnpm lint && pnpm test'.",
          }),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      normalize: (raw) => normalizeTextArgs(raw, 'command'),
      run: async (params, signal) => {
        const input = parseTextArgs(params, 'command');
        if (!input.ok) return errorResult('run_checks', input.error);
        const payload: RunChecksInput = {
          dispatchId: input.value.dispatchId,
          command: input.value.text,
        };
        const result = await host.runChecks(payload, signal);
        if (!result.ok) return errorResult('run_checks', result.error);
        return textResult(formatChecks(payload.command, result), result);
      },
    }),
    tool({
      name: 'merge_worktree',
      label: 'Merge worktree',
      description:
        "Merge a worker's branch into your current branch with --no-ff. Use it only after review_diff and run_checks pass. " +
        'On conflicts the merge is aborted, the target branch stays unchanged and the conflicting files are listed. ' +
        'Without git there is nothing to merge: it accepts the work in place and completes the task.',
      promptSnippet: "Merge an accepted worker's branch (--no-ff)",
      promptGuidelines: [
        'Merge only after you reviewed the diff and the checks passed in this conversation.',
      ],
      parameters: dispatchRefSchema(),
      executionMode: 'sequential',
      normalize: normalizeRefArgs,
      run: async (params, signal) => {
        const input = parseRefArgs(params);
        if (!input.ok) return errorResult('merge_worktree', input.error);
        const result = await host.mergeWorktree(input.value, signal);
        if (!result.ok) return errorResult('merge_worktree', result.error);
        return textResult(formatMerge(input.value.dispatchId, result), result);
      },
    }),
    tool({
      name: 'reject_work',
      label: 'Reject work',
      description:
        'Send review feedback to a worker and put its task back in progress. The worker keeps its worktree, ' +
        'fixes the issues and must report_done again.',
      promptSnippet: 'Send concrete review feedback back to a worker',
      parameters: Type.Object(
        {
          dispatch_id: dispatchIdParam(),
          feedback: Type.String({
            description:
              'Concrete feedback: what is wrong, where (files, failing command output) and what passing looks like.',
          }),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      normalize: (raw) => normalizeTextArgs(raw, 'feedback'),
      run: async (params, signal) => {
        const input = parseTextArgs(params, 'feedback');
        if (!input.ok) return errorResult('reject_work', input.error);
        const payload: RejectWorkInput = {
          dispatchId: input.value.dispatchId,
          feedback: input.value.text,
        };
        const result = await host.rejectWork(payload, signal);
        if (!result.ok) return errorResult('reject_work', result.error);
        return textResult(
          [
            `## Feedback sent · dispatch ${code(payload.dispatchId)}`,
            `- message_id: ${code(result.messageId)}`,
            '',
            'The worker continues in the same worktree. You will be woken automatically when it reports again; review its next worker_done like the first.',
          ].join('\n'),
          result
        );
      },
    }),
    tool({
      name: 'cleanup_worktree',
      label: 'Clean up worktree',
      description:
        "Remove a worker's worktree and its branch. Call it after merge_worktree, or to abandon a task. " +
        'Without git it only stops the worker; its changes stay in the workspace directory.',
      promptSnippet: "Remove a finished or abandoned worker's worktree",
      parameters: dispatchRefSchema(),
      executionMode: 'sequential',
      normalize: normalizeRefArgs,
      run: async (params, signal) => {
        const input = parseRefArgs(params);
        if (!input.ok) return errorResult('cleanup_worktree', input.error);
        const result = await host.cleanupWorktree(input.value, signal);
        if (!result.ok) return errorResult('cleanup_worktree', result.error);
        return textResult(formatCleanup(input.value.dispatchId, result), result);
      },
    }),
  ];
}

interface ToolSpec<S extends TSchema> {
  name: OrchestrationToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: S;
  executionMode?: 'sequential' | 'parallel';
  /** 归一化（prepareArguments）：不抛异常，类型不对的值留给 schema 校验 */
  normalize: (raw: unknown) => ArgRecord;
  /** 语义校验 + 调用 Host；异常由 safely 兜底 */
  run: (params: unknown, signal: AbortSignal | undefined) => Promise<ToolResult>;
}

function tool<S extends TSchema>(spec: ToolSpec<S>): ToolDefinition {
  return defineTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
    parameters: spec.parameters,
    ...(spec.executionMode ? { executionMode: spec.executionMode } : {}),
    prepareArguments: (raw) => {
      try {
        return spec.normalize(raw) as Static<S>;
      } catch {
        return raw as Static<S>;
      }
    },
    execute: (_toolCallId, params, signal) => safely(spec.name, () => spec.run(params, signal)),
  });
}

// ---------------------------------------------------------------------------
// 参数 schema

function dispatchIdParam() {
  return Type.String({
    description: 'dispatch_id returned by dispatch_task (also shown by list_workers).',
  });
}

function dispatchRefSchema() {
  return Type.Object({ dispatch_id: dispatchIdParam() }, { additionalProperties: false });
}

function dispatchTaskSchema(roles: readonly RoleOption[]) {
  const roleDescription =
    roles.length > 0
      ? `Role id of the worker. Default "${DEFAULT_ROLE_ID}". Available: ${roles.map(describeRole).join('; ')}`
      : `Role id of the worker. Default "${DEFAULT_ROLE_ID}" (plain worker without extra prompt, skills or MCP).`;
  return Type.Object(
    {
      title: Type.String({
        description:
          'Short task title (under 80 characters), used for the worker card and the branch name.',
      }),
      spec: Type.String({
        description:
          "Complete task brief in Markdown; it is the worker's only context. Cover Target, Change, " +
          'Constraints, Ownership (files and directories it may change) and Acceptance (commands that must pass).',
      }),
      role: Type.Optional(
        roles.length > 0
          ? StringEnum(
              roles.map((role) => role.id),
              { description: roleDescription }
            )
          : Type.String({ description: roleDescription })
      ),
      depends_on: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'task_ids from earlier dispatch_task results that must be completed (merged) before this task starts.',
        })
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Model for the worker: a configured model id (e.g. "gpt-5.5") or "providerId/modelId" to disambiguate. ' +
            "Only set it when the user names a model for this task; omitted = the role's model, else your current model.",
        })
      ),
      thinking: Type.Optional(
        StringEnum([...THINKING_LEVELS], {
          description:
            'Thinking level for the worker. Only set it when the user names one; omitted = the default of the model, role or your session.',
        })
      ),
    },
    { additionalProperties: false }
  );
}

function describeRole(role: RoleOption): string {
  const name = role.name && role.name !== role.id ? ` (${role.name})` : '';
  return `${role.id}${name}${role.description ? `: ${role.description}` : ''}`;
}

// ---------------------------------------------------------------------------
// 归一化（prepareArguments）与语义校验（execute）

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeRole(value: unknown, roles: readonly RoleOption[]): unknown {
  if (value === undefined || value === null) return DEFAULT_ROLE_ID;
  if (value === null) return undefined;
  if (typeof value !== 'string') return value;
  const wanted = value.trim();
  if (!wanted) return DEFAULT_ROLE_ID;
  const lower = wanted.toLowerCase();
  const match = roles.find(
    (role) => role.id.toLowerCase() === lower || role.name?.trim().toLowerCase() === lower
  );
  return match ? match.id : wanted;
}

function normalizeDispatchArgs(raw: unknown, roles: readonly RoleOption[]): ArgRecord {
  const args = asRecord(raw);
  const title = trimmed(pick(args, 'title'));
  return compact({
    title:
      typeof title === 'string' ? truncateHeadChars(oneLine(title), TITLE_MAX_CHARS).text : title,
    spec: trimmed(pick(args, 'spec')),
    role: normalizeRole(pick(args, 'role', 'role_id', 'roleId'), roles),
    depends_on: stringList(pick(args, 'depends_on', 'dependsOn')) ?? [],
    model: emptyToUndefined(trimmed(pick(args, 'model', 'model_id', 'modelId'))),
    thinking: normalizeThinking(
      pick(args, 'thinking', 'thinking_level', 'thinkingLevel', 'reasoning_effort')
    ),
  });
}

function emptyToUndefined(value: unknown): unknown {
  return value === '' || value === null ? undefined : value;
}

/** 档位不区分大小写、去空白；`none` 归一为 `off`；认不出的原样留给校验报错 */
function normalizeThinking(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const wanted = value.trim().toLowerCase();
  if (wanted === '') return undefined;
  return normalizeThinkingLevel(wanted) ?? wanted;
}

function parseDispatchArgs(
  params: unknown,
  roles: readonly RoleOption[]
): Parsed<DispatchTaskInput> {
  const args = normalizeDispatchArgs(params, roles);
  const title = requiredText(args.title, 'title');
  if (!title.ok) return title;
  const spec = requiredText(args.spec, 'spec');
  if (!spec.ok) return spec;
  const role = requiredText(args.role, 'role');
  if (!role.ok) return role;
  if (roles.length > 0 && !roles.some((candidate) => candidate.id === role.value)) {
    return {
      ok: false,
      error: `unknown role "${role.value}". Available: ${roles.map((r) => r.id).join(', ')}`,
    };
  }
  if (!isStringArray(args.depends_on)) {
    return { ok: false, error: 'depends_on must be an array of task ids' };
  }
  if (args.model !== undefined && typeof args.model !== 'string') {
    return { ok: false, error: 'model must be a model id string' };
  }
  const thinking = args.thinking === undefined ? undefined : normalizeThinkingLevel(args.thinking);
  if (args.thinking !== undefined && thinking === undefined) {
    return { ok: false, error: `thinking must be one of ${THINKING_LEVELS.join(', ')}` };
  }
  return {
    ok: true,
    value: {
      title: title.value,
      spec: spec.value,
      roleId: role.value,
      dependsOn: args.depends_on,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    },
  };
}

function normalizeWaitArgs(raw: unknown): ArgRecord {
  const args = asRecord(raw);
  const timeout = integerish(pick(args, 'timeout_ms', 'timeoutMs'));
  const until = trimmed(pick(args, 'until'));
  return {
    timeout_ms:
      timeout === undefined
        ? WAIT_TIMEOUT_DEFAULT_MS
        : typeof timeout === 'number' && Number.isFinite(timeout)
          ? clamp(timeout, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_MAX_MS)
          : timeout,
    until:
      until === undefined || until === ''
        ? 'all'
        : typeof until === 'string'
          ? until.toLowerCase()
          : until,
  };
}

function parseWaitArgs(params: unknown): Parsed<WaitForWorkersInput> {
  const args = normalizeWaitArgs(params);
  const timeoutMs = args.timeout_ms;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
    return { ok: false, error: 'timeout_ms must be an integer number of milliseconds' };
  }
  if (args.until !== 'any' && args.until !== 'all') {
    return { ok: false, error: `until must be 'any' or 'all'` };
  }
  return { ok: true, value: { timeoutMs, until: args.until } };
}

function normalizeRefArgs(raw: unknown): ArgRecord {
  return compact({ dispatch_id: trimmed(pick(asRecord(raw), 'dispatch_id', 'dispatchId')) });
}

function parseRefArgs(params: unknown): Parsed<DispatchRef> {
  const id = requiredText(normalizeRefArgs(params).dispatch_id, 'dispatch_id');
  return id.ok ? { ok: true, value: { dispatchId: id.value } } : id;
}

function normalizeReadArgs(raw: unknown): ArgRecord {
  const cursor = integerish(pick(asRecord(raw), 'cursor'));
  return compact({
    ...normalizeRefArgs(raw),
    cursor: typeof cursor === 'number' && Number.isFinite(cursor) ? Math.max(0, cursor) : cursor,
  });
}

function parseReadArgs(params: unknown): Parsed<ReadWorkerOutputInput> {
  const ref = parseRefArgs(params);
  if (!ref.ok) return ref;
  const cursor = normalizeReadArgs(params).cursor ?? 0;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor)) {
    return { ok: false, error: 'cursor must be a non-negative integer from a previous result' };
  }
  return { ok: true, value: { dispatchId: ref.value.dispatchId, cursor } };
}

function normalizeTextArgs(raw: unknown, key: string): ArgRecord {
  return compact({ ...normalizeRefArgs(raw), [key]: trimmed(pick(asRecord(raw), key)) });
}

function parseTextArgs(params: unknown, key: string): Parsed<{ dispatchId: string; text: string }> {
  const ref = parseRefArgs(params);
  if (!ref.ok) return ref;
  const text = requiredText(normalizeTextArgs(params, key)[key], key);
  if (!text.ok) return text;
  return { ok: true, value: { dispatchId: ref.value.dispatchId, text: text.value } };
}

// ---------------------------------------------------------------------------
// 给模型的结构化文本（Markdown 小节）

function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

/** 派发时指定了模型或思考档位才显示 */
function modelLines(task: Task): string[] {
  if (task.model === undefined && task.thinking === undefined) return [];
  const thinking = task.thinking ? ` · thinking: ${task.thinking}` : '';
  return [`- model: ${task.model ?? 'default'}${thinking}`];
}

function formatDispatched(task: Task, dispatch: Dispatch | undefined): string {
  if (!dispatch) {
    return [
      '## Task queued',
      `- task_id: ${code(task.id)}`,
      `- title: ${task.title}`,
      `- role: ${task.roleId}`,
      ...modelLines(task),
      `- status: ${task.status}`,
      `- depends_on: ${task.dependsOn.map(code).join(', ') || 'none'}`,
      '',
      'Its worker starts automatically once the dependencies are completed. Keep monitoring with wait_for_workers.',
    ].join('\n');
  }
  const inPlace = dispatch.mode === 'in-place';
  return [
    '## Task dispatched',
    `- task_id: ${code(task.id)}`,
    `- dispatch_id: ${code(dispatch.id)}`,
    `- title: ${task.title}`,
    `- role: ${task.roleId}`,
    ...modelLines(task),
    inPlace
      ? '- works in: the workspace directory itself (no git: no worktree or branch)'
      : `- branch: ${code(dispatch.branch)}`,
    `- status: ${task.status}`,
    '',
    inPlace
      ? 'No git: the worker edits files directly in the workspace directory, and every running worker shares it. Dispatch one task at a time unless their files are strictly disjoint. You know nothing about its result until its worker_done message arrives; you will be woken automatically when it reports.'
      : 'The worker runs in the background in its own worktree. You know nothing about its result until its worker_done message arrives; you will be woken automatically when it reports, so keep working with the user or dispatch more tasks.',
  ].join('\n');
}

function formatWorkers(workers: readonly WorkerEntry[]): string {
  if (workers.length === 0) {
    return '## Workers (0)\nNo tasks have been dispatched in this run yet.';
  }
  const blocks = workers.map(({ task, dispatch }) => {
    const lines = [
      `### ${code(task.id)} · ${task.title}`,
      `- status: ${task.status} · role: ${task.roleId}`,
      ...modelLines(task),
    ];
    if (task.dependsOn.length > 0)
      lines.push(`- depends_on: ${task.dependsOn.map(code).join(', ')}`);
    if (!dispatch) {
      lines.push('- not started yet (waiting for dependencies)');
      return lines.join('\n');
    }
    lines.push(
      dispatch.mode === 'in-place'
        ? `- dispatch_id: ${code(dispatch.id)} · in place (no git)`
        : `- dispatch_id: ${code(dispatch.id)} · branch: ${code(dispatch.branch)}`
    );
    if (dispatch.outcome) {
      const summary = dispatch.summary ? ` — ${firstLine(dispatch.summary)}` : '';
      lines.push(`- outcome: ${dispatch.outcome}${summary}`);
    }
    if (dispatch.filesModified && dispatch.filesModified.length > 0) {
      lines.push(`- files modified: ${dispatch.filesModified.length}`);
    }
    return lines.join('\n');
  });
  return [`## Workers (${workers.length})`, ...blocks].join('\n\n');
}

function formatWait(result: WaitForWorkersOutput, timeoutMs: number): string {
  const lines = [
    '## Wait result',
    `- timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `- still running: ${result.pending}`,
  ];
  if (result.messages.length === 0) {
    lines.push(
      '',
      result.timedOut
        ? `The wait timed out after ${seconds(timeoutMs)} without new messages. This is not a failure: workers keep running. Call wait_for_workers again, or check progress with list_workers / read_worker_output.`
        : 'No new messages.'
    );
    return lines.join('\n');
  }
  lines.push('', `## Messages (${result.messages.length})`);
  for (const message of result.messages) lines.push('', formatMessage(message));
  if (result.timedOut) {
    lines.push('', 'The wait timed out; this is not a failure and the other workers keep running.');
  }
  return lines.join('\n');
}

function formatMessage(message: Message): string {
  const ref = message.dispatchId ? ` · dispatch ${code(message.dispatchId)}` : '';
  const subject = message.subject ? ` · ${message.subject}` : '';
  const body = truncateHeadChars(message.body, MESSAGE_BODY_MAX_CHARS);
  return [
    `### ${message.type}${ref}${subject}`,
    `- from: ${message.from} · message_id: ${code(message.id)}`,
    '',
    body.truncated ? `${body.text}\n…(${body.omitted} more characters)` : body.text,
    '',
    `Next: ${nextStep(message)}`,
  ].join('\n');
}

function nextStep(message: Message): string {
  const target = message.dispatchId ? `dispatch_id "${message.dispatchId}"` : 'its dispatch_id';
  switch (message.type) {
    case 'question':
      return `answer with send_to_worker (${target}); the worker is blocked until you reply.`;
    case 'escalation':
      return `decide how to proceed (ask the user when the decision is theirs), then send_to_worker, reject_work or cleanup_worktree (${target}).`;
    case 'worker_done':
      return `review_diff and run_checks (${target}), then merge_worktree if it passes or reject_work with concrete feedback.`;
    default:
      return 'no action required.';
  }
}

function formatWorkerOutput(
  input: ReadWorkerOutputInput,
  result: { text: string; total: number; done: boolean }
): string {
  const page = truncateHeadChars(result.text, WORKER_OUTPUT_PAGE_CHARS);
  const end = input.cursor + page.text.length;
  const state = result.done ? 'worker settled' : 'worker still running';
  const lines = [
    `## Worker output · dispatch ${code(input.dispatchId)}`,
    `Characters ${input.cursor}–${end} of ${result.total} (${state}).`,
    '',
    page.text ? fence(page.text) : '(no new output)',
  ];
  if (page.truncated || end < result.total) {
    lines.push(
      '',
      '## More output',
      `Output truncated. Call read_worker_output with dispatch_id "${input.dispatchId}" and cursor ${end} to continue.`
    );
  }
  return lines.join('\n');
}

function listFiles(files: readonly string[]): string {
  const listed = files.slice(0, MAX_LISTED_FILES).map(code);
  if (files.length > MAX_LISTED_FILES) listed.push(`… and ${files.length - MAX_LISTED_FILES} more`);
  return listed.join(', ');
}

/** 普通目录没有 diff：给出 worker 汇报的改动文件，让主 agent 自己读、自己跑检查。 */
function formatInPlaceReview(dispatchId: string, files: readonly string[]): string {
  return [
    `## Diff · dispatch ${code(dispatchId)}`,
    'No git: this workspace is not a git repository, so there is no diff to show.',
    files.length === 0
      ? '- files reported by the worker: none'
      : `- files reported by the worker (${files.length}): ${listFiles(files)}`,
    '',
    files.length === 0
      ? 'The worker listed no modified files in report_done. Check read_worker_output, or reject_work asking it to list every file it changed.'
      : 'Read those files with read and grep to review the work, then verify it with run_checks.',
  ].join('\n');
}

function formatDiff(dispatchId: string, result: ReviewDiffOutput): string {
  if (result.mode === 'in-place') return formatInPlaceReview(dispatchId, result.files);
  const header = [
    `## Diff · dispatch ${code(dispatchId)}`,
    `- branch: ${code(result.branch)} (base ${code(shortSha(result.baseCommit))})`,
  ];
  if (result.files.length === 0 && !result.diff.trim()) {
    return [
      ...header,
      '',
      `No changes on ${code(result.branch)} relative to its base. The worker may not have committed its work: check read_worker_output, or reject_work asking it to commit.`,
    ].join('\n');
  }
  const diff = truncateHeadChars(result.diff, DIFF_MAX_CHARS);
  const lines = [
    ...header,
    `- files changed (${result.files.length}): ${listFiles(result.files)}`,
    '',
    '### Stat',
    fence(result.stat || '(empty)'),
    '',
    '### Diff',
    fence(diff.text, 'diff'),
  ];
  if (diff.truncated) {
    lines.push(
      '',
      `Diff truncated: showing ${diff.text.length} of ${result.diff.length} characters. Read single files with git_readonly, e.g. args ["diff", "${shortSha(result.baseCommit)}..${result.branch}", "--", "<path>"].`
    );
  }
  return lines.join('\n');
}

function formatChecks(
  command: string,
  result: { exitCode: number; output: string; durationMs: number }
): string {
  const passed = result.exitCode === 0;
  const output = truncateTailChars(result.output, CHECK_OUTPUT_MAX_CHARS);
  const lines = [
    passed ? '## Checks passed' : `## Checks FAILED (exit code ${result.exitCode})`,
    `- command: ${code(command)}`,
    `- duration: ${seconds(result.durationMs)}`,
    '',
    output.truncated
      ? `### Output (last ${output.text.length} of ${result.output.length} characters)`
      : '### Output',
    fence(output.text || '(no output)'),
  ];
  if (!passed) {
    lines.push(
      '',
      'Do not merge. Send the failing output to the worker with reject_work, or rerun if the failure is unrelated to its change.'
    );
  }
  return lines.join('\n');
}

function formatMerge(dispatchId: string, result: MergeWorktreeOutput): string {
  if (result.mode === 'in-place') {
    return [
      '## Accepted (no git)',
      `- dispatch ${code(dispatchId)}: nothing to merge, its changes are already in the workspace directory; the task is completed`,
      '',
      'Next: cleanup_worktree for this dispatch to stop its worker, then report the result to the user.',
    ].join('\n');
  }
  if (result.merged) {
    const commit = result.commit ? ` as ${code(shortSha(result.commit))}` : '';
    return [
      '## Merged',
      `- dispatch ${code(dispatchId)} merged into ${code(result.targetBranch)}${commit}`,
      '',
      'Next: cleanup_worktree for this dispatch, then report the result to the user.',
    ].join('\n');
  }
  const conflicts = result.conflicts?.map(code).join(', ') || 'unknown';
  return [
    '## Not merged — conflicts, merge aborted',
    `- target: ${code(result.targetBranch)} (unchanged)`,
    `- conflicting files: ${conflicts}`,
    '',
    'Ask the worker to merge or rebase onto the target branch and resolve the conflicts (reject_work), then review again.',
  ].join('\n');
}

function formatCleanup(dispatchId: string, result: CleanupWorktreeOutput): string {
  const title = `## Cleaned up · dispatch ${code(dispatchId)}`;
  if (result.mode === 'in-place') {
    return [
      title,
      '- no git: there is no worktree or branch to remove; nothing to clean up',
      '- the worker was stopped; the changes it made stay in the workspace directory',
    ].join('\n');
  }
  return [
    title,
    `- worktree removed: ${result.removedWorktree ? 'yes' : 'no'}`,
    `- branch deleted: ${result.deletedBranch ? 'yes' : 'no'}`,
  ].join('\n');
}
