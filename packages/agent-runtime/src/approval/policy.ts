import type { ApprovalMode } from '@fynvra/core';
import { asRecord } from '../tools/args';
import { truncateHeadChars } from '../tools/result';

// 与 src/shared/types/chat.ts 的 ApprovalKind / ApprovalDecision 同形（packages 不能 import src）。
/** 审批类别 */
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';
/** 人的决定：放行一次 / 本会话同类（kind + 工具名）后续自动放行 / 拒绝 */
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';

/** 审批条展示用 */
export interface ToolCallDescription {
  /** 工具名 */
  title: string;
  /** 命令全文 / 文件路径（每行一个）/ 参数预览 */
  detail: string;
}

/** 参数预览（MCP 等没有约定字段的工具）的长度上限 */
export const APPROVAL_ARGS_PREVIEW_CHARS = 2_000;

/**
 * 会改状态的工具。pi 的 bash / powershell / write / edit、编排的 run_checks（在 worker 的 worktree 里执行命令），
 * 以及 apply_patch（pi 1.4 没有，按约定预留）。MCP 工具按 `mcp__<server>__<tool>` 的命名识别。
 */
const TOOL_KINDS = new Map<string, ApprovalKind>([
  ['bash', 'command'],
  ['powershell', 'command'],
  ['run_checks', 'command'],
  ['write', 'file-write'],
  ['edit', 'file-edit'],
  ['apply_patch', 'file-edit'],
]);

const MODE_KINDS: Record<ApprovalMode, readonly ApprovalKind[]> = {
  supervised: ['command', 'file-write', 'file-edit', 'mcp'],
  'auto-edits': ['command', 'mcp'],
  full: [],
};

/** 工具的审批类别；只读与协调类工具（read / grep / report_done / dispatch_task …）返回 null，任何档位都不审批 */
export function approvalKindOf(toolName: string): ApprovalKind | null {
  return TOOL_KINDS.get(toolName) ?? (toolName.startsWith('mcp__') ? 'mcp' : null);
}

/** 该档位是否要审批这一类工具；不认识的档位按 supervised 处理（fail-closed） */
export function modeRequiresApproval(mode: ApprovalMode, kind: ApprovalKind): boolean {
  return (MODE_KINDS[mode] ?? MODE_KINDS.supervised).includes(kind);
}

/** command 类工具参数里的命令全文 */
export function commandOf(input: unknown): string | undefined {
  const { command } = asRecord(input);
  return typeof command === 'string' ? command : undefined;
}

export function describeToolCall(
  toolName: string,
  kind: ApprovalKind,
  input: unknown
): ToolCallDescription {
  const detail =
    kind === 'command'
      ? commandOf(input)
      : kind === 'mcp'
        ? undefined
        : writeTargets(toolName, input).join('\n') || undefined;
  return { title: toolName, detail: detail ?? argsPreview(input) };
}

/** 文件工具的写目标：pi 的 write / edit 用 `path`；apply_patch 从补丁头里取 */
function writeTargets(toolName: string, input: unknown): string[] {
  const args = asRecord(input);
  if (toolName === 'apply_patch') {
    const patch = [args.input, args.patch].find((value) => typeof value === 'string');
    return typeof patch === 'string' ? patchTargets(patch) : [];
  }
  return typeof args.path === 'string' && args.path ? [args.path] : [];
}

function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const match of patch.matchAll(
    /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
  )) {
    const target = (match[1] as string).trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

function argsPreview(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
  const preview = truncateHeadChars(text, APPROVAL_ARGS_PREVIEW_CHARS - 1);
  return preview.truncated ? `${preview.text}…` : text;
}
