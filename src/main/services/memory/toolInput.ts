import { isMemoryCategory, type MemoryCategory } from '@shared/types/memory';

// project_memory_* 的入参在 Main 再校验一次（不信任 agent 进程），规则与 agent-runtime 的 memoryTools 一致。

export const TOOL_CONTENT_MAX = 500;
export const TOOL_QUOTE_MAX = 300;
export const TOOL_NOTE_MAX = 300;
export const TOOL_FILES_MAX = 10;
export const TOOL_IDS_MAX = 20;
export const TOOL_LIMIT_DEFAULT = 10;
export const TOOL_LIMIT_MAX = 20;

export interface WriteInput {
  action: 'add' | 'update' | 'delete';
  id?: number;
  category?: MemoryCategory;
  content?: string;
  files?: string[];
  quote?: string;
  force?: boolean;
}
export interface SearchInput {
  query?: string;
  ids?: number[];
  category?: MemoryCategory;
  limit: number;
}
export interface FeedbackInput {
  id: number;
  verdict: 'useful' | 'outdated';
  note?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'input must be an object';
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  return extra === undefined ? (raw as Record<string, unknown>) : `unknown field: ${extra}`;
}

/** 可选文本：去首尾空白后为空视为没给；超上限或含 NUL 报错 */
function text(value: unknown, name: string, max: number): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return fail(`${name} must be a string`);
  const trimmed = value.trim();
  if ([...trimmed].length > max) return fail(`${name} is longer than ${max} characters`);
  if (trimmed.includes('\0')) return fail(`${name} must not contain NUL`);
  return { ok: true, value: trimmed || undefined };
}

function category(value: unknown): Parsed<MemoryCategory | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return isMemoryCategory(value) ? { ok: true, value } : fail('invalid category');
}

/** 仓库相对路径：统一成 /，拒绝绝对路径与 .. 段 */
export function parseFilesInput(value: unknown): Parsed<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || !value.every((file) => typeof file === 'string')) {
    return fail('files must be a list of repo-relative paths');
  }
  if (value.length > TOOL_FILES_MAX) return fail(`files takes at most ${TOOL_FILES_MAX} paths`);
  const files = (value as string[]).map((file) =>
    file.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  );
  const bad = files.find(
    (file) =>
      file === '' ||
      file.includes('\0') ||
      /^(\/|[a-zA-Z]:)/.test(file) ||
      file.split('/').includes('..')
  );
  return bad === undefined
    ? { ok: true, value: files }
    : fail(`files must be repo-relative paths: ${bad}`);
}

export function parseWriteInput(raw: unknown): Parsed<WriteInput> {
  const args = record(raw, ['action', 'id', 'category', 'content', 'files', 'quote', 'force']);
  if (typeof args === 'string') return fail(args);
  const { action } = args;
  if (action !== 'add' && action !== 'update' && action !== 'delete') {
    return fail('action must be one of add, update, delete');
  }
  if (args.id !== undefined && !isId(args.id)) return fail('id must be a positive integer');
  if (args.force !== undefined && typeof args.force !== 'boolean') {
    return fail('force must be true or false');
  }
  const cat = category(args.category);
  if (!cat.ok) return cat;
  const content = text(args.content, 'content', TOOL_CONTENT_MAX);
  if (!content.ok) return content;
  const quote = text(args.quote, 'quote', TOOL_QUOTE_MAX);
  if (!quote.ok) return quote;
  const files = parseFilesInput(args.files);
  if (!files.ok) return files;
  const id = args.id as number | undefined;
  if (action === 'add' && (!cat.value || !content.value)) {
    return fail('add needs category and content');
  }
  if (action !== 'add' && id === undefined) return fail(`${action} needs id`);
  if (action === 'update' && !content.value && !cat.value && !files.value) {
    return fail('update needs at least one of content, category, files');
  }
  return {
    ok: true,
    value: {
      action,
      id,
      category: cat.value,
      content: content.value,
      files: files.value,
      quote: quote.value,
      force: args.force === true,
    },
  };
}

export function parseSearchInput(raw: unknown): Parsed<SearchInput> {
  const args = record(raw ?? {}, ['query', 'ids', 'category', 'limit']);
  if (typeof args === 'string') return fail(args);
  const query = text(args.query, 'query', 1000);
  if (!query.ok) return query;
  const cat = category(args.category);
  if (!cat.ok) return cat;
  let ids: number[] | undefined;
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids) || !args.ids.every(isId)) {
      return fail('ids must be a list of positive integers');
    }
    if (args.ids.length > TOOL_IDS_MAX) return fail(`ids takes at most ${TOOL_IDS_MAX} ids`);
    ids = [...new Set(args.ids as number[])];
    if (ids.length === 0) ids = undefined;
  }
  const limit = args.limit ?? TOOL_LIMIT_DEFAULT;
  if (!isId(limit) || limit > TOOL_LIMIT_MAX) {
    return fail(`limit must be an integer from 1 to ${TOOL_LIMIT_MAX}`);
  }
  return { ok: true, value: { query: query.value, ids, category: cat.value, limit } };
}

export function parseFeedbackInput(raw: unknown): Parsed<FeedbackInput> {
  const args = record(raw, ['id', 'verdict', 'note']);
  if (typeof args === 'string') return fail(args);
  if (!isId(args.id)) return fail('id must be a positive integer');
  if (args.verdict !== 'useful' && args.verdict !== 'outdated') {
    return fail('verdict must be one of useful, outdated');
  }
  const note = text(args.note, 'note', TOOL_NOTE_MAX);
  if (!note.ok) return note;
  return { ok: true, value: { id: args.id, verdict: args.verdict, note: note.value } };
}
