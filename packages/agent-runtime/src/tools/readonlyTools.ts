import { type Static, Type } from '@earendil-works/pi-ai';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { type ExecFn, nodeExec } from '../exec';
import { asRecord, compact, pick } from './args';
import {
  errorResult,
  fence,
  inlineCode,
  safely,
  textResult,
  truncateHeadChars,
  truncateTailChars,
} from './result';

export const GIT_READONLY_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'branch', 'worktree'];
export const GIT_OUTPUT_MAX_CHARS = 30_000;

const GIT_TIMEOUT_MS = 30_000;
const GIT_STDERR_MAX_CHARS = 4_000;
/** 只读、不分页、不拿可选锁（git status 不回写 index，也不和 Main 的 git 操作抢锁） */
const GIT_PREFIX = ['--no-pager', '--no-optional-locks'];

// git branch 只允许列出分支：创建 / 删除 / 改名 / 设上游的选项都不在名单里
const BRANCH_FLAGS = new Set([
  '--all',
  '--remotes',
  '--list',
  '--verbose',
  '--ignore-case',
  '--show-current',
  '--color',
  '--no-color',
  '--column',
  '--no-column',
  '--no-abbrev',
  '--omit-empty',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--points-at',
]);
const BRANCH_FLAG_PREFIXES = [
  '--sort=',
  '--format=',
  '--color=',
  '--column=',
  '--abbrev=',
  '--merged=',
  '--no-merged=',
  '--contains=',
  '--no-contains=',
  '--points-at=',
];
/** 后面可以跟一个独立的提交参数 */
const BRANCH_VALUE_FLAGS = new Set([
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--points-at',
]);
/** 可合并的短选项：-a -r -l -v -i（如 -av、-vv） */
const BRANCH_SHORT_FLAGS = /^-[arlvi]+$/;
const WORKTREE_LIST_FLAGS = new Set(['--porcelain', '-v', '--verbose', '-z']);

export interface ReadonlyToolsOptions {
  /** git_readonly 用的命令执行器，默认 child_process.execFile */
  exec?: ExecFn;
}

/** 只读工具集：pi 的 read / grep / find / ls，加上 git_readonly */
export function createReadonlyTools(
  cwd: string,
  options: ReadonlyToolsOptions = {}
): ToolDefinition[] {
  return [
    widen(createReadToolDefinition(cwd)),
    widen(createGrepToolDefinition(cwd)),
    widen(createFindToolDefinition(cwd)),
    widen(createLsToolDefinition(cwd)),
    createGitReadonlyTool(cwd, options.exec ?? nodeExec),
  ];
}

/** pi 的具体工具定义 → customTools 需要的宽类型 */
function widen(tool: ToolDefinition<any, any>): ToolDefinition {
  return tool;
}

const gitSchema = Type.Object(
  {
    args: Type.Array(Type.String(), {
      minItems: 1,
      description:
        'git arguments without the leading "git", e.g. ["log", "--oneline", "-20"] or ["diff", "main...fynvra/my-task", "--stat"]. ' +
        'Allowed subcommands: status, log, diff, show, branch (listing only), worktree list.',
    }),
  },
  { additionalProperties: false }
);

/** 白名单 git 命令（status / log / diff / show / branch 列表 / worktree list），通过注入的 exec 执行 */
export function createGitReadonlyTool(cwd: string, exec: ExecFn): ToolDefinition {
  return defineTool({
    name: 'git_readonly',
    label: 'Git (read-only)',
    description:
      'Run a read-only git command in the working directory. Allowed: status, log, diff, show, branch (listing only), worktree list. ' +
      'Options that write files (--output) or run external diff programs (--ext-diff) are refused.',
    promptSnippet:
      'git_readonly: run read-only git commands (status, log, diff, show, branch, worktree list)',
    parameters: gitSchema,
    prepareArguments: (raw) => normalizeGitArgs(raw) as Static<typeof gitSchema>,
    execute: (_toolCallId, params, signal) =>
      safely('git_readonly', async () => {
        const args = normalizeGitArgs(params).args;
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          return errorResult('git_readonly', 'args must be an array of strings');
        }
        const check = checkGitArgs(args);
        if (!check.ok) return errorResult('git_readonly', check.error);
        const result = await exec('git', [...GIT_PREFIX, ...args], cwd, {
          timeoutMs: GIT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        if (result.code !== 0) {
          const stderr = truncateTailChars(result.stderr.trim(), GIT_STDERR_MAX_CHARS).text;
          return errorResult(
            'git_readonly',
            `git ${args[0]} exited with code ${result.code}${stderr ? `\n${stderr}` : ''}`
          );
        }
        const output = truncateHeadChars(result.stdout, GIT_OUTPUT_MAX_CHARS);
        const lines = [
          `## ${inlineCode(`git ${args.join(' ')}`)}`,
          fence(output.text || '(no output)'),
        ];
        if (output.truncated) {
          lines.push(
            '',
            `Output truncated: showing ${output.text.length} of ${result.stdout.length} characters. Narrow the command (paths, -n, --stat) to see the rest.`
          );
        }
        return textResult(lines.join('\n'), { args, truncated: output.truncated });
      }),
  });
}

function normalizeGitArgs(raw: unknown) {
  let args = pick(asRecord(raw), 'args', 'argv');
  // 模型偶尔传整条命令字符串；含引号的复杂参数应传数组
  if (typeof args === 'string') args = args.trim().split(/\s+/).filter(Boolean);
  if (Array.isArray(args) && args[0] === 'git') args = args.slice(1);
  return compact({ args });
}

export type GitArgsCheck = { ok: true } | { ok: false; error: string };

/**
 * git_readonly 的白名单校验（纯函数）。子命令必须在第一位，因此 `-C`、`--git-dir`、`-c` 等全局选项进不来。
 */
export function checkGitArgs(args: readonly string[]): GitArgsCheck {
  const fail = (error: string): GitArgsCheck => ({ ok: false, error });
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return fail('args must start with a git subcommand');
  if (args.some((arg) => arg.length === 0)) return fail('args must not contain empty strings');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
  if (args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))) {
    return fail('args must not contain control characters');
  }
  if (!GIT_READONLY_SUBCOMMANDS.includes(subcommand)) {
    return fail(
      `git ${subcommand} is not allowed; allowed: status, log, diff, show, branch (listing only), worktree list`
    );
  }
  for (const arg of rest) {
    if (arg === '--output' || arg.startsWith('--output=')) {
      return fail(`${arg} is not allowed: git_readonly never writes files`);
    }
    if (arg === '--ext-diff') {
      return fail('--ext-diff is not allowed: external diff programs are disabled');
    }
  }
  if (subcommand === 'worktree') {
    const [action, ...flags] = rest;
    if (action !== 'list' || flags.some((flag) => !WORKTREE_LIST_FLAGS.has(flag))) {
      return fail('only `git worktree list` (with --porcelain, -v or -z) is allowed');
    }
  }
  if (subcommand === 'branch') return checkBranchArgs(rest);
  return { ok: true };
}

function checkBranchArgs(rest: readonly string[]): GitArgsCheck {
  let listing = false;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const allowed =
      BRANCH_FLAGS.has(arg) ||
      BRANCH_SHORT_FLAGS.test(arg) ||
      BRANCH_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix));
    if (!allowed) {
      return {
        ok: false,
        error: `git branch ${arg} is not allowed: git_readonly only lists branches`,
      };
    }
    if (arg === '--list' || (BRANCH_SHORT_FLAGS.test(arg) && arg.includes('l'))) listing = true;
    // 可选的提交参数紧随其后；以 - 开头的下一个参数仍按选项校验
    const next = rest[index + 1];
    if (BRANCH_VALUE_FLAGS.has(arg) && next !== undefined && !next.startsWith('-')) index++;
  }
  if (positionals.length > 0 && !listing) {
    return {
      ok: false,
      error: `git branch ${positionals[0]} would create a branch; to filter branches use --list <pattern>`,
    };
  }
  return { ok: true };
}
