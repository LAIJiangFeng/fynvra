import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkRestrictedCommand,
  isProtectedPath,
  isSensitivePath,
  type SessionProfile,
} from '@fynvra/core';
import { asRecord } from '../tools/args';
import { CONFIG_TOOL_NAME } from '../tools/configTool';
import { type ApprovalKind, commandOf, fileTargetsOf } from './policy';

/** 读类工具：目标在 `path` 参数里，grep / find / ls 不带时就是 cwd */
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const COMMAND_TOOLS = new Set(['bash', 'powershell']);
// pi 会把这些空白规整成普通空格（`.env\u00a0` 在 Windows 上就是 .env），直接拒绝
const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;

/**
 * triage / restricted 会话的工具调用判定（§5 会话档位）：只有放行或拒绝，不问人，与审批档位无关。
 * 放行返回 undefined，拒绝返回给模型看的英文原因（写明原因与替代做法）。永不抛异常。
 */
export async function profileRefusal(
  profile: SessionProfile,
  cwd: string | undefined,
  toolName: string,
  input: unknown,
  kind: ApprovalKind | null
): Promise<string | undefined> {
  const label = `${profile} session`;
  if (kind === 'network' || kind === 'mcp' || kind === 'plugin') {
    return `${label}: ${toolName} is not allowed (no network, MCP or plugin tools); work only with the files in the working directory`;
  }
  if (toolName === CONFIG_TOOL_NAME) return `${label}: Fynvra configuration is not available`;
  if (COMMAND_TOOLS.has(toolName) || toolName === 'run_checks') {
    const command = commandOf(input);
    if (command === undefined) return `${label}: the command is missing`;
    const checked = checkRestrictedCommand(command, {
      mode: toolName === 'run_checks' ? 'checks' : 'worker',
    });
    return checked.ok ? undefined : `${label}: ${checked.reason}`;
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
    const rel = await confinedPath(cwd, target);
    if (rel === undefined) {
      return `${label}: path outside the working directory is not allowed (${target}); use paths inside the working directory only`;
    }
    if (isSensitivePath(target) || isSensitivePath(rel)) {
      return `${label}: ${target} is a sensitive file (keys, credentials or local config) and cannot be read or written; leave it alone`;
    }
    if (write && (isProtectedPath(target) || isProtectedPath(rel))) {
      return `${label}: ${target} is protected (CI, package manifests, lock files, scripts or tool config) and cannot be changed; stop and report that a maintainer has to change it`;
    }
  }
  return undefined;
}

/**
 * 目标相对 cwd 解析后取真实路径（含符号链接 / junction）；目标不存在时取最近已存在父目录的真实路径再拼接。
 * 在 cwd 的真实路径之内返回相对路径（cwd 本身为 `.`），否则或解析失败返回 undefined。
 */
export async function confinedPath(cwd: string, target: string): Promise<string | undefined> {
  // pi 会展开 `~`、去掉 `@` 前缀、解析 file:// 与（Windows 上）`/c/...`：与这里的解析不同，一律拒绝
  if (/^[~@]/.test(target) || /^file:/i.test(target) || UNICODE_SPACES.test(target)) return;
  if (process.platform === 'win32' && /^[\\/]/.test(target)) return;
  try {
    const root = await fs.realpath(cwd);
    const real = await realpathOfNearest(path.resolve(cwd, target));
    const rel = path.relative(root, real);
    if (rel === '') return '.';
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    return rel;
  } catch {
    return;
  }
}

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
