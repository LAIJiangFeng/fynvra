import {
  APPROVAL_MODES,
  isApprovalMode,
  isThinkingLevel,
  isToolPolicy,
  THINKING_LEVELS,
  TOOL_POLICIES,
} from '../guards';
import type { Role } from '../types';

/** {@link parseRole} 的结果：成功带归一化后的角色，失败带首个错误（含字段路径）。 */
export type ParseRoleResult = { ok: true; role: Role } | { ok: false; error: string };

const ROLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * 角色 id 是否为合法 slug：小写字母、数字、`-`，1–64 字符，不以 `-` 开头或结尾。
 * 合法 id 不含路径分隔符，可直接用作文件名。
 */
export function isValidRoleId(value: unknown): value is string {
  return typeof value === 'string' && ROLE_ID_PATTERN.test(value);
}

/**
 * 把任意输入（JSON 文件、IPC 入参）收窄为 {@link Role}，不抛异常。
 *
 * - 只读自有属性，未知字段丢弃；可选字段为 `null` 视同缺省（instructionFileId 的 null 表示不使用）。
 * - `skillIds` / `mcpServerIds` 缺省为 `[]`，去重并保持顺序；`name` 去首尾空白。
 * - `tools` / `approvalMode` 必填：权限相关字段缺失时拒绝，而不是猜一个默认值。
 */
export function parseRole(input: unknown): ParseRoleResult {
  try {
    return { ok: true, role: readRole(input) };
  } catch (error) {
    if (error instanceof RoleInputError) return { ok: false, error: error.message };
    throw error;
  }
}

class RoleInputError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new RoleInputError(message);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 自有属性；`null` 归一为 `undefined`。 */
function field(record: object, key: string): unknown {
  const value = Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
  return value === null ? undefined : value;
}

function oneOf(members: readonly string[]): string {
  return members.map((member) => `'${member}'`).join(' | ');
}

function optionalString(record: object, key: string): string | undefined {
  const value = field(record, key);
  check(value === undefined || typeof value === 'string', `role.${key} must be a string`);
  return value;
}

function readIdList(record: object, key: string): string[] {
  const value = field(record, key);
  if (value === undefined) return [];
  check(
    Array.isArray(value) && value.every(isNonEmptyString),
    `role.${key} must be an array of non-empty strings`
  );
  return [...new Set<string>(value)];
}

function readModel(value: unknown): NonNullable<Role['model']> {
  check(isRecord(value), 'role.model must be an object');
  const providerId = field(value, 'providerId');
  check(isNonEmptyString(providerId), 'role.model.providerId must be a non-empty string');
  const modelId = field(value, 'modelId');
  check(isNonEmptyString(modelId), 'role.model.modelId must be a non-empty string');
  const thinking = field(value, 'thinking');
  if (thinking === undefined) return { providerId, modelId };
  check(isThinkingLevel(thinking), `role.model.thinking must be one of ${oneOf(THINKING_LEVELS)}`);
  return { providerId, modelId, thinking };
}

function readRole(input: unknown): Role {
  check(isRecord(input), 'role must be an object');
  const id = field(input, 'id');
  check(
    isValidRoleId(id),
    'role.id must be a lowercase slug: a-z, 0-9 and "-", 1-64 chars, no leading or trailing "-"'
  );
  const name = field(input, 'name');
  check(isNonEmptyString(name), 'role.name must be a non-empty string');
  const description = optionalString(input, 'description');
  const builtin = field(input, 'builtin');
  check(builtin === undefined || typeof builtin === 'boolean', 'role.builtin must be a boolean');
  const systemPrompt = optionalString(input, 'systemPrompt');
  const rawModel = field(input, 'model');
  const model = rawModel === undefined ? undefined : readModel(rawModel);
  const skillIds = readIdList(input, 'skillIds');
  const instructionFileId = Object.hasOwn(input, 'instructionFileId')
    ? (input as Record<string, unknown>).instructionFileId
    : undefined;
  check(
    instructionFileId === undefined ||
      instructionFileId === null ||
      isValidRoleId(instructionFileId),
    'role.instructionFileId must be a registry ID or null'
  );
  const mcpServerIds = readIdList(input, 'mcpServerIds');
  const tools = field(input, 'tools');
  check(isToolPolicy(tools), `role.tools must be one of ${oneOf(TOOL_POLICIES)}`);
  const approvalMode = field(input, 'approvalMode');
  check(isApprovalMode(approvalMode), `role.approvalMode must be one of ${oneOf(APPROVAL_MODES)}`);

  // 按 §4 字段顺序构造，落盘的 JSON 也保持这个顺序
  return {
    id,
    name: name.trim(),
    ...(description === undefined ? {} : { description }),
    ...(builtin === undefined ? {} : { builtin }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(model === undefined ? {} : { model }),
    skillIds,
    ...(instructionFileId === undefined
      ? {}
      : { instructionFileId: instructionFileId as string | null }),
    mcpServerIds,
    tools,
    approvalMode,
  };
}
