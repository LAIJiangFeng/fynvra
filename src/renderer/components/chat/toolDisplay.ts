import { asRecord } from '@shared/guards';
import type { T } from '../../i18n';

// 工具调用卡片的展示信息（纯函数）：显示名（字典 tools.labels.<工具名>）、所属类别、标题行的参数摘要

/** builtin：pi 编程工具；orchestration：主 agent 的编排工具；worker：worker 的汇报 / 提问工具 */
export type ToolFamily = 'builtin' | 'orchestration' | 'worker' | 'mcp' | 'other';

export interface ToolDisplay {
  label: string;
  family: ToolFamily;
  /** 标题行里的一行参数摘要；没有可显示的参数时为空串 */
  summary: string;
}

interface ToolSpec {
  family: ToolFamily;
  /** 依次尝试作为摘要的参数名 */
  keys: string[];
}

const TOOLS = {
  read: { family: 'builtin', keys: ['path'] },
  bash: { family: 'builtin', keys: ['command'] },
  edit: { family: 'builtin', keys: ['path'] },
  write: { family: 'builtin', keys: ['path'] },
  grep: { family: 'builtin', keys: ['pattern'] },
  find: { family: 'builtin', keys: ['pattern'] },
  ls: { family: 'builtin', keys: ['path'] },
  git_readonly: { family: 'builtin', keys: ['args'] },
  dispatch_task: { family: 'orchestration', keys: ['title'] },
  list_workers: { family: 'orchestration', keys: [] },
  wait_for_workers: { family: 'orchestration', keys: ['until'] },
  read_worker_output: { family: 'orchestration', keys: ['dispatch_id'] },
  send_to_worker: { family: 'orchestration', keys: ['body'] },
  review_diff: { family: 'orchestration', keys: ['dispatch_id'] },
  run_checks: { family: 'orchestration', keys: ['command'] },
  merge_worktree: { family: 'orchestration', keys: ['dispatch_id'] },
  reject_work: { family: 'orchestration', keys: ['feedback'] },
  cleanup_worktree: { family: 'orchestration', keys: ['dispatch_id'] },
  ask_coordinator: { family: 'worker', keys: ['question'] },
  report_done: { family: 'worker', keys: ['summary'] },
} satisfies Record<string, ToolSpec>;

type KnownTool = keyof typeof TOOLS;

function isKnownTool(name: string): name is KnownTool {
  return Object.hasOwn(TOOLS, name);
}

const SUMMARY_MAX_CHARS = 120;
const MCP_PREFIX = 'mcp__';

export function describeTool(name: string, args: unknown, t: T): ToolDisplay {
  if (isKnownTool(name)) {
    const spec: ToolSpec = TOOLS[name];
    const record = asRecord(args);
    const value = spec.keys.map((key) => textOf(record?.[key])).find(Boolean) ?? '';
    return { label: t(`tools.labels.${name}`), family: spec.family, summary: oneLine(value) };
  }
  if (name.startsWith(MCP_PREFIX)) {
    // pi 的 MCP 工具名为 mcp__<server>__<tool>
    const [server = '', ...rest] = name.slice(MCP_PREFIX.length).split('__');
    return {
      label: `MCP · ${server}/${rest.join('__')}`,
      family: 'mcp',
      summary: compactJson(args),
    };
  }
  return { label: name, family: 'other', summary: compactJson(args) };
}

/** 展开后的完整参数：字符串原样，其余 JSON 缩进 */
export function prettyArgs(args: unknown): string {
  if (args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2) ?? '';
  } catch {
    return String(args);
  }
}

export interface DispatchTaskView {
  title: string;
  role: string;
  dependsOn: string[];
  /** 任务书（Markdown） */
  spec: string;
}

/** dispatch_task 卡片：任务标题、角色（缺省 worker）、依赖、任务书 */
export function dispatchTaskView(args: unknown): DispatchTaskView {
  const record = asRecord(args);
  return {
    title: textOf(record?.title),
    role: textOf(record?.role) || 'worker',
    dependsOn: stringsOf(record?.depends_on),
    spec: typeof record?.spec === 'string' ? record.spec : '',
  };
}

export interface ReportDoneView {
  outcome: 'succeeded' | 'failed' | null;
  summary: string;
  filesModified: string[];
}

/** report_done 卡片：结果、总结、改动文件 */
export function reportDoneView(args: unknown): ReportDoneView {
  const record = asRecord(args);
  const outcome = record?.outcome;
  return {
    outcome: outcome === 'succeeded' || outcome === 'failed' ? outcome : null,
    summary: textOf(record?.summary),
    filesModified: stringsOf(record?.files_modified),
  };
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return stringsOf(value).join(' ');
  return '';
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…` : flat;
}

function compactJson(args: unknown): string {
  const record = asRecord(args);
  if (!record || Object.keys(record).length === 0) return '';
  try {
    return oneLine(JSON.stringify(record));
  } catch {
    return '';
  }
}
