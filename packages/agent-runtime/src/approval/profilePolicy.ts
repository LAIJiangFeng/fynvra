import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRestrictedCommand,
  isProtectedPath,
  isSensitivePath,
  normalizeRepoPath,
  type SessionProfile,
} from '@fynvra/core';
import { asRecord } from '../tools/args';
import { CONFIG_TOOL_NAME } from '../tools/configTool';
import { type ApprovalKind, commandOf, fileTargetsOf } from './policy';

/** 读类工具：目标在 `path` 参数里，grep / find / ls 不带时就是 cwd */
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const COMMAND_TOOLS = new Set(['bash', 'powershell']);
/** 命令工具可能带的工作目录参数：给了就必须在 cwd 之内 */
const COMMAND_DIR_KEYS = [
  'cwd',
  'workdir',
  'working_directory',
  'workingDirectory',
  'directory',
  'dir',
];
// pi 会把这些空白规整成普通空格（`.env\u00a0` 在 Windows 上就是 .env），直接拒绝
const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;

/** 档位判定要求问人：只有 restricted 会话的 run_checks `pnpm test` */
export interface ProfileNeedsApproval {
  needsApproval: true;
  command: string;
}

/**
 * triage / restricted 会话的工具调用判定（§5 会话档位）：与审批档位无关，几乎都是直接放行或拒绝。
 * 放行返回 undefined，拒绝返回给模型看的英文原因（写明原因与替代做法）；
 * 唯一的例外是 restricted 会话的 run_checks `pnpm test`，返回 {@link ProfileNeedsApproval}，由审批门问维护者。永不抛异常。
 */
export async function profileRefusal(
  profile: SessionProfile,
  cwd: string | undefined,
  toolName: string,
  input: unknown,
  kind: ApprovalKind | null,
  readonlyRoots: readonly string[] = []
): Promise<string | ProfileNeedsApproval | undefined> {
  const label = `${profile} session`;
  if (kind === 'network' || kind === 'mcp' || kind === 'plugin') {
    return `${label}: ${toolName} is not allowed (no network, MCP or plugin tools); work only with the files in the working directory`;
  }
  if (toolName === CONFIG_TOOL_NAME) return `${label}: Fynvra configuration is not available`;
  if (COMMAND_TOOLS.has(toolName) || toolName === 'run_checks') {
    const command = commandOf(input);
    if (command === undefined) return `${label}: the command is missing`;
    for (const key of COMMAND_DIR_KEYS) {
      const dir = asRecord(input)[key];
      if (dir === undefined) continue;
      if (typeof dir !== 'string' || cwd === undefined) {
        return `${label}: the ${key} argument must be a path inside the working directory`;
      }
      const refusal = await pathRefusal(label, cwd, dir, false);
      if (refusal) return refusal;
    }
    const checked = checkRestrictedCommand(command, {
      mode: toolName === 'run_checks' ? 'checks' : 'worker',
    });
    if (!checked.ok) return `${label}: ${checked.reason}`;
    if (!checked.needsApproval) return undefined;
    return profile === 'restricted'
      ? { needsApproval: true, command: command.trim() }
      : `${label}: ${toolName} is not allowed`;
  }
  if (kind === 'command') return `${label}: ${toolName} is not allowed`;
  const write = kind === 'file-write' || kind === 'file-edit';
  if (!write && !READ_TOOLS.has(toolName)) return undefined;
  const raw = asRecord(input).path;
  const targets = write
    ? fileTargetsOf(toolName, input)
    : typeof raw === 'string' && raw !== ''
      ? [raw]
      : [];
  if (write && targets.length === 0) {
    return `${label}: the target file of ${toolName} could not be determined; name one file inside the working directory`;
  }
  if (cwd === undefined) return `${label}: the working directory is unknown`;
  for (const target of targets) {
    // 只读根（聊天附件副本）里的路径只许读；写照旧按 cwd 之外拒绝
    if (!write && (await insideReadonlyRoot(readonlyRoots, cwd, target, false))) continue;
    const refusal = await pathRefusal(label, cwd, target, write);
    if (refusal) return refusal;
  }
  return undefined;
}

/** 一个路径参数的判定（读或写）；放行返回 undefined */
async function pathRefusal(
  label: string,
  cwd: string,
  target: string,
  write: boolean
): Promise<string | undefined> {
  const confined = await confinedPath(cwd, target);
  if (confined === 'outside') {
    return `${label}: path outside the working directory is not allowed (${target}); use paths inside the working directory only`;
  }
  if (confined === 'malformed') {
    return `${label}: path "${target}" is not allowed (alternate data streams, trailing dots or spaces, wildcards, ~ or @ prefixes); use a plain relative path inside the working directory`;
  }
  const paths = [confined.requested, confined.real];
  if (paths.some(isSensitivePath)) {
    return `${label}: ${target} is a sensitive file (keys, credentials or local config) and cannot be read or written; leave it alone`;
  }
  if (write && paths.some(isProtectedPath)) {
    return `${label}: ${target} is protected (CI, package manifests, lock files, dependencies, scripts or tool config) and cannot be changed; stop and report that a maintainer has to change it`;
  }
  return undefined;
}

export type ConfinedPath = { requested: string; real: string } | 'outside' | 'malformed';

/**
 * 路径检查顺序：
 * 1. 相对 cwd 解析，得到的相对路径必须能被 normalizeRepoPath 规范化（拒绝 ADS、末尾点或空格、通配符等）；
 * 2. 用原生 realpath 取真实路径（Windows 上还原 8.3 短名与大小写）；目标不存在时取最近已存在祖先的真实路径再拼接；
 * 3. 真实路径必须在 cwd 的真实路径之内。
 * 返回请求得到的相对路径与真实相对路径（cwd 本身为 `.`），两者都要交给敏感 / 保护判定。
 */
export async function confinedPath(cwd: string, target: string): Promise<ConfinedPath> {
  // pi 会展开 `~`、去掉 `@` 前缀、解析 file:// 与（Windows 上）`/c/...`：与这里的解析不同，一律拒绝
  if (/^[~@]/.test(target) || /^file:/i.test(target) || UNICODE_SPACES.test(target)) {
    return 'malformed';
  }
  if (process.platform === 'win32' && /^[\\/]/.test(target)) return 'malformed';
  const absolute = path.resolve(cwd, target);
  const requested = path.relative(path.resolve(cwd), absolute);
  if (isOutside(requested)) return 'outside';
  if (requested !== '' && normalizeRepoPath(requested) === null) return 'malformed';
  try {
    const root = await fs.realpath(cwd);
    const real = path.relative(root, await realpathOfNearest(absolute));
    if (isOutside(real)) return 'outside';
    return { requested: requested || '.', real: real || '.' };
  } catch {
    return 'outside';
  }
}

/**
 * target 是否落在某个只读根之内（按解析后的路径与真实路径各比一次，任一命中即是）。
 * `lenient` 为 true（判断要不要拦写入）时像 pi 一样去掉 `@` 前缀、展开 `~`、解析 file:// ，宁可多拦；
 * 为 false（判断能不能放行读取）时这些写法一律不算，宁可少放。永不抛异常
 */
export async function insideReadonlyRoot(
  roots: readonly string[],
  cwd: string | undefined,
  target: string,
  lenient: boolean
): Promise<boolean> {
  if (roots.length === 0 || target === '') return false;
  let resolved = target;
  if (lenient) {
    resolved = resolved.replace(/^@/, '');
    if (resolved === '~' || /^~[\\/]/.test(resolved)) {
      resolved = path.join(os.homedir(), resolved.slice(1));
    } else if (/^file:/i.test(resolved)) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        return false;
      }
    }
  } else if (/^[~@]/.test(target) || /^file:/i.test(target) || UNICODE_SPACES.test(target)) {
    return false;
  }
  const absolute = path.resolve(cwd ?? process.cwd(), resolved);
  let real: string | undefined;
  try {
    real = await realpathOfNearest(absolute);
  } catch {
    real = undefined;
  }
  for (const root of roots) {
    const base = path.resolve(root);
    const lexical = !isOutside(path.relative(base, absolute));
    if (lexical && lenient) return true;
    if (real === undefined) continue;
    let realBase = base;
    try {
      realBase = await fs.realpath(base);
    } catch {
      // 根目录还不存在：只按解析后的路径比
    }
    const realInside = !isOutside(path.relative(realBase, real));
    // 放行读取要求两者都在根内（链接指向根外的不算）；拦写入任一命中即拦
    if (lenient ? realInside : lexical && realInside) return true;
  }
  return false;
}

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** fs/promises 的 realpath 是原生实现（不是 JS 版 fs.realpathSync），会还原 8.3 短名 */
async function realpathOfNearest(absolute: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

const SEARCH_TOOLS = new Set(['grep', 'find', 'ls']);
// grep 的行形如 `path:12: text`（匹配行）或 `path-12- text`（上下文行）；路径里也可能有这些字符，逐个候选前缀都查
const GREP_LINE_MARK = /:\d+: |-\d+- /g;

/** 一行搜索结果是否指向敏感文件；grep 行按所有可能的路径前缀判定（宁可多删） */
function sensitiveLine(toolName: string, line: string): boolean {
  if (toolName !== 'grep') return isSensitivePath(line.trim());
  for (const match of line.matchAll(GREP_LINE_MARK)) {
    if (isSensitivePath(line.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * 档位会话的 grep / find / ls：从结果里删掉指向敏感文件的条目（例如仓库里提交了的 .env 的内容）。
 * 有条目被删时一并去掉 details（其中的截断信息可能带原文）。其他工具原样返回。
 */
export function filterSensitiveResults<T extends { content: unknown; details?: unknown }>(
  toolName: string,
  result: T
): T {
  if (!SEARCH_TOOLS.has(toolName) || !Array.isArray(result.content)) return result;
  let removed = false;
  const content = result.content.map((part: unknown) => {
    const block = part as { type?: unknown; text?: unknown };
    if (block?.type !== 'text' || typeof block.text !== 'string') return part;
    const lines = block.text.split('\n');
    const kept = lines.filter((line) => !sensitiveLine(toolName, line));
    if (kept.length === lines.length) return part;
    removed = true;
    const text = kept.join('\n').trim();
    return { ...block, text: text === '' ? 'No results (sensitive files are hidden)' : text };
  });
  return removed ? { ...result, content, details: undefined } : result;
}
