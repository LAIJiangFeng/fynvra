import { type Static, StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  HostResult,
  MemoryCategory,
  MemoryFeedbackInput,
  MemoryHost,
  MemorySearchInput,
  MemoryWriteInput,
} from '../host';
import { asRecord, compact, integerish, type Parsed, pick, stringList, trimmed } from './args';
import { errorResult, fence, safely, type ToolResult, textResult } from './result';

export const MEMORY_SEARCH_TOOL_NAME = 'project_memory_search';
export const MEMORY_FEEDBACK_TOOL_NAME = 'project_memory_feedback';
export const MEMORY_WRITE_TOOL_NAME = 'project_memory_write';

export const MEMORY_CATEGORIES = [
  'rule',
  'workflow',
  'pitfall',
  'architecture',
  'reference',
] as const satisfies readonly MemoryCategory[];

/** 各字段上限（单位：字符，按 Unicode 码点计） */
export const MEMORY_CONTENT_MAX_CHARS = 500;
export const MEMORY_QUOTE_MAX_CHARS = 300;
export const MEMORY_NOTE_MAX_CHARS = 300;
export const MEMORY_FILES_MAX = 10;
export const MEMORY_IDS_MAX = 20;
export const MEMORY_SEARCH_LIMIT_DEFAULT = 10;
export const MEMORY_SEARCH_LIMIT_MAX = 20;

const WRITE_ACTIONS = ['add', 'update', 'delete'] as const;
const VERDICTS = ['useful', 'outdated'] as const;

const idParam = (description: string) => Type.Optional(Type.Integer({ minimum: 1, description }));
const categoryParam = (description: string) =>
  Type.Optional(StringEnum(MEMORY_CATEGORIES, { description }));

const searchSchema = Type.Object(
  {
    query: Type.Optional(
      Type.String({ description: 'Keywords to search for. Omit (with ids) to list entries.' })
    ),
    ids: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        description: `Memory ids to expand (at most ${MEMORY_IDS_MAX}): returns full text, source, files and status.`,
      })
    ),
    category: categoryParam('Only entries of this category.'),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MEMORY_SEARCH_LIMIT_MAX,
        description: `Max results, 1-${MEMORY_SEARCH_LIMIT_MAX} (default ${MEMORY_SEARCH_LIMIT_DEFAULT}).`,
      })
    ),
  },
  { additionalProperties: false }
);

const feedbackSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1, description: 'The memory id.' }),
    verdict: StringEnum(VERDICTS, {
      description:
        'useful: it held up when checked against the code; outdated: it no longer holds.',
    }),
    note: Type.Optional(
      Type.String({
        description: `Optional short reason, at most ${MEMORY_NOTE_MAX_CHARS} characters (what changed, if outdated).`,
      })
    ),
  },
  { additionalProperties: false }
);

const writeSchema = Type.Object(
  {
    action: StringEnum(WRITE_ACTIONS, {
      description:
        'add: needs category and content. update: needs id and at least one of content, category, files. delete: needs id.',
    }),
    id: idParam('update / delete: the memory id.'),
    category: categoryParam(
      'rule: a convention to follow; workflow: required environment or build/test steps; pitfall: a trap and its fix; ' +
        'architecture: where things live and how they fit; reference: ids and locations of external resources.'
    ),
    content: Type.Optional(
      Type.String({
        description: `The fact, self-contained and actionable, at most ${MEMORY_CONTENT_MAX_CHARS} characters. Write it in the user's language.`,
      })
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description: `Repo-relative paths the fact is about (at most ${MEMORY_FILES_MAX}).`,
      })
    ),
    quote: Type.Optional(
      Type.String({
        description: `When the user explicitly asked you to remember / forget this: their exact words (at most ${MEMORY_QUOTE_MAX_CHARS} characters). Also needed to change or delete a pinned memory.`,
      })
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          'add: write even though similar entries were returned (after you checked them).',
      })
    ),
  },
  { additionalProperties: false }
);

/**
 * 项目记忆工具：search / feedback 给所有非档位会话，write 只给可写的非 worker 会话（由 createRoleSession 决定）。
 * 不碰文件、命令和网络，审批门不归类（任何档位都不审批）；存储与权限由 Main 的记忆服务负责。
 */
export function createMemoryTools(host: MemoryHost, options: { write: boolean }): ToolDefinition[] {
  const tools = [createMemorySearchTool(host), createMemoryFeedbackTool(host)];
  return options.write ? [...tools, createMemoryWriteTool(host)] : tools;
}

export function createMemorySearchTool(host: MemoryHost): ToolDefinition {
  return defineTool({
    name: MEMORY_SEARCH_TOOL_NAME,
    label: 'Project memory search',
    description:
      'Search the long-term project memory shared by all sessions of this project. ' +
      'Give query to search by keywords, ids to expand entries (full text, source, files, status), ' +
      'or neither to list entries (optionally of one category).',
    promptSnippet: 'Search or expand project memory entries',
    parameters: searchSchema,
    prepareArguments: (raw) => normalizeSearchArgs(raw) as Static<typeof searchSchema>,
    execute: (_toolCallId, params, signal) =>
      safely(MEMORY_SEARCH_TOOL_NAME, async () => {
        const parsed = parseMemorySearch(params);
        if (!parsed.ok) return errorResult(MEMORY_SEARCH_TOOL_NAME, parsed.error);
        return hostResult(MEMORY_SEARCH_TOOL_NAME, await host.search(parsed.value, signal));
      }),
  });
}

export function createMemoryFeedbackTool(host: MemoryHost): ToolDefinition {
  return defineTool({
    name: MEMORY_FEEDBACK_TOOL_NAME,
    label: 'Project memory feedback',
    description:
      'After checking a project memory entry against the code, report whether it was useful or is outdated.',
    promptSnippet: 'Report a project memory entry as useful or outdated',
    parameters: feedbackSchema,
    prepareArguments: (raw) => normalizeFeedbackArgs(raw) as Static<typeof feedbackSchema>,
    execute: (_toolCallId, params, signal) =>
      safely(MEMORY_FEEDBACK_TOOL_NAME, async () => {
        const parsed = parseMemoryFeedback(params);
        if (!parsed.ok) return errorResult(MEMORY_FEEDBACK_TOOL_NAME, parsed.error);
        return hostResult(MEMORY_FEEDBACK_TOOL_NAME, await host.feedback(parsed.value, signal));
      }),
  });
}

export function createMemoryWriteTool(host: MemoryHost): ToolDefinition {
  return defineTool({
    name: MEMORY_WRITE_TOOL_NAME,
    label: 'Project memory write',
    description:
      'Add, update or delete a long-term project memory entry, shared by all future sessions of this project. ' +
      'Write when the user says "remember" or "forget", or when you learned a durable fact future sessions will need: ' +
      'a convention, a required environment or build step, a pitfall and its fix, where something lives, an external resource id. ' +
      'Do not write task progress, guesses, general knowledge, secrets, or anything already in AGENTS.md or rule files. ' +
      "When the user explicitly asked you to remember it, put the user's exact words in quote: once verified, the entry is kept permanently. " +
      'If the result lists similar candidates instead of writing, update or delete those entries, ' +
      'or retry with force: true once you have confirmed this one is really new.',
    promptSnippet: 'Add, update or delete a long-term project memory entry',
    parameters: writeSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) => normalizeWriteArgs(raw) as Static<typeof writeSchema>,
    execute: (_toolCallId, params, signal) =>
      safely(MEMORY_WRITE_TOOL_NAME, async () => {
        const parsed = parseMemoryWrite(params);
        if (!parsed.ok) return errorResult(MEMORY_WRITE_TOOL_NAME, parsed.error);
        return hostResult(MEMORY_WRITE_TOOL_NAME, await host.write(parsed.value, signal));
      }),
  });
}

function hostResult(toolName: string, result: HostResult<{ result?: unknown }>): ToolResult {
  if (!result.ok) return errorResult(toolName, result.error);
  return textResult(
    `## ${toolName}\n${fence(JSON.stringify(result.result ?? null, null, 2), 'json')}`
  );
}

// ---- 参数解析：execute 里再校验一次（prepareArguments 只修形状，schema 校验可能被绕过） ----

export function parseMemorySearch(raw: unknown): Parsed<MemorySearchInput> {
  const args = normalizeSearchArgs(raw);
  const query = optionalText(args.query, 'query');
  if (!query.ok) return query;
  const category = optionalCategory(args.category);
  if (!category.ok) return category;
  let ids: number[] | undefined;
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids) || !args.ids.every(isPositiveInt)) {
      return { ok: false, error: 'ids must be a list of positive integers' };
    }
    if (args.ids.length > MEMORY_IDS_MAX) {
      return { ok: false, error: `ids takes at most ${MEMORY_IDS_MAX} ids` };
    }
    ids = [...new Set(args.ids as number[])];
    if (ids.length === 0) ids = undefined;
  }
  const limit = args.limit ?? MEMORY_SEARCH_LIMIT_DEFAULT;
  if (!isPositiveInt(limit) || limit > MEMORY_SEARCH_LIMIT_MAX) {
    return { ok: false, error: `limit must be an integer from 1 to ${MEMORY_SEARCH_LIMIT_MAX}` };
  }
  return {
    ok: true,
    value: compact({
      query: query.value,
      ids,
      category: category.value,
      limit,
    }) as MemorySearchInput,
  };
}

export function parseMemoryFeedback(raw: unknown): Parsed<MemoryFeedbackInput> {
  const args = normalizeFeedbackArgs(raw);
  if (!isPositiveInt(args.id)) return { ok: false, error: 'id must be a positive integer' };
  if (!(VERDICTS as readonly unknown[]).includes(args.verdict)) {
    return { ok: false, error: `verdict must be one of ${VERDICTS.join(', ')}` };
  }
  const note = optionalText(args.note, 'note', MEMORY_NOTE_MAX_CHARS);
  if (!note.ok) return note;
  return {
    ok: true,
    value: compact({
      id: args.id,
      verdict: args.verdict,
      note: note.value,
    }) as unknown as MemoryFeedbackInput,
  };
}

export function parseMemoryWrite(raw: unknown): Parsed<MemoryWriteInput> {
  const args = normalizeWriteArgs(raw);
  const action = args.action;
  if (!(WRITE_ACTIONS as readonly unknown[]).includes(action)) {
    return { ok: false, error: `action must be one of ${WRITE_ACTIONS.join(', ')}` };
  }
  if (args.id !== undefined && !isPositiveInt(args.id)) {
    return { ok: false, error: 'id must be a positive integer' };
  }
  const category = optionalCategory(args.category);
  if (!category.ok) return category;
  const content = optionalText(args.content, 'content', MEMORY_CONTENT_MAX_CHARS);
  if (!content.ok) return content;
  const quote = optionalText(args.quote, 'quote', MEMORY_QUOTE_MAX_CHARS);
  if (!quote.ok) return quote;
  let files: string[] | undefined;
  if (args.files !== undefined) {
    if (!Array.isArray(args.files) || !args.files.every((file) => typeof file === 'string')) {
      return { ok: false, error: 'files must be a list of repo-relative paths' };
    }
    if (args.files.length > MEMORY_FILES_MAX) {
      return { ok: false, error: `files takes at most ${MEMORY_FILES_MAX} paths` };
    }
    // 仓库相对路径：统一成 /，拒绝绝对路径与 ..（Main 侧还会再校验）
    files = (args.files as string[]).map((file) => file.replace(/\\/g, '/').replace(/^\.\//, ''));
    const bad = files.find(
      (file) => /^(\/|[a-zA-Z]:)/.test(file) || file.split('/').includes('..')
    );
    if (bad !== undefined) {
      return { ok: false, error: `files must be repo-relative paths: ${bad}` };
    }
  }
  if (args.force !== undefined && typeof args.force !== 'boolean') {
    return { ok: false, error: 'force must be true or false' };
  }
  const id = args.id as number | undefined;
  switch (action) {
    case 'add':
      if (!category.value) return { ok: false, error: 'add needs category' };
      if (!content.value) return { ok: false, error: 'add needs content' };
      break;
    case 'update':
      if (id === undefined) return { ok: false, error: 'update needs id' };
      if (!content.value && !category.value && !files) {
        return { ok: false, error: 'update needs at least one of content, category, files' };
      }
      break;
    default:
      if (id === undefined) return { ok: false, error: 'delete needs id' };
  }
  return {
    ok: true,
    value: compact({
      action,
      id,
      category: category.value,
      content: content.value,
      files,
      quote: quote.value,
      force: args.force === true ? true : undefined,
    }) as unknown as MemoryWriteInput,
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** 可选文本：trim 后为空视为没给；超过上限报错 */
function optionalText(value: unknown, name: string, max?: number): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `${name} must be a string` };
  const text = value.trim();
  if (max !== undefined && [...text].length > max) {
    return { ok: false, error: `${name} is longer than ${max} characters` };
  }
  return { ok: true, value: text || undefined };
}

function optionalCategory(value: unknown): Parsed<MemoryCategory | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return (MEMORY_CATEGORIES as readonly unknown[]).includes(value)
    ? { ok: true, value: value as MemoryCategory }
    : { ok: false, error: `category must be one of ${MEMORY_CATEGORIES.join(', ')}` };
}

const lower = (value: unknown) => {
  const text = trimmed(value);
  return typeof text === 'string' ? text.toLowerCase() : text;
};

/** 单个 id / 数字字符串 / 逗号分隔 → 整数数组；其余原样返回 */
function idList(value: unknown): unknown {
  const items = typeof value === 'number' ? [value] : stringList(value, /[\s,]+/);
  return Array.isArray(items) ? items.map((item) => integerish(item)) : items;
}

function normalizeSearchArgs(raw: unknown) {
  const args = asRecord(raw);
  const query = trimmed(pick(args, 'query', 'q'));
  return compact({
    query: query === '' ? undefined : query,
    ids: idList(pick(args, 'ids', 'id')),
    category: lower(pick(args, 'category')),
    limit: integerish(pick(args, 'limit')),
  });
}

function normalizeFeedbackArgs(raw: unknown) {
  const args = asRecord(raw);
  return compact({
    id: integerish(pick(args, 'id')),
    verdict: lower(pick(args, 'verdict')),
    note: pick(args, 'note', 'reason'),
  });
}

function normalizeWriteArgs(raw: unknown) {
  const args = asRecord(raw);
  const force = pick(args, 'force');
  return compact({
    action: lower(pick(args, 'action')),
    id: integerish(pick(args, 'id')),
    category: lower(pick(args, 'category')),
    content: pick(args, 'content'),
    files: stringList(pick(args, 'files')),
    quote: pick(args, 'quote'),
    force: force === 'true' ? true : force === 'false' ? false : force,
  });
}
