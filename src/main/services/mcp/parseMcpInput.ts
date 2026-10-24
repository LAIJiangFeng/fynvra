import { asRecord } from '@shared/guards';
import type { McpServerEntry } from '@shared/types/llm';
import type { McpUpsertInput, SecretFieldInput } from '../../../preload/domains/mcp';
import { isRegistryId } from '../providers/jsonRegistry';

export type ParseMcpResult = { ok: true; input: McpUpsertInput } | { ok: false; error: string };

const UPSERT_KEYS = new Set([
  'id',
  'name',
  'transport',
  'command',
  'args',
  'url',
  'enabled',
  'env',
  'headers',
]);
const FIELD_KEYS = new Set(['key', 'value']);
const TRANSPORTS: Readonly<Record<McpServerEntry['transport'], true>> = {
  stdio: true,
  sse: true,
  http: true,
};
const MAX_NAME_LENGTH = 80;
const MAX_COMMAND_LENGTH = 1024;
const MAX_ARGS = 200;
const MAX_ARG_LENGTH = 8192;
const MAX_URL_LENGTH = 2048;
const MAX_FIELDS = 200;
const MAX_FIELD_KEY_LENGTH = 256;
const MAX_FIELD_VALUE_LENGTH = 16_384;

class InputError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InputError(message);
}

/**
 * `mcp:upsert` 入参收窄（严格）：未知字段、与传输方式不符的字段一律拒绝。
 * 名称、命令、URL、键名去首尾空白；参数和 env / headers 的值保持原样（空格可能有意义）。
 */
export function parseMcpUpsert(raw: unknown): ParseMcpResult {
  try {
    return { ok: true, input: readUpsert(raw) };
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: error.message };
    throw error;
  }
}

function readUpsert(raw: unknown): McpUpsertInput {
  const record = asRecord(raw);
  check(record, '无效的 MCP 服务器：需要一个对象');
  const unknownKey = Object.keys(record).find((key) => !UPSERT_KEYS.has(key));
  check(unknownKey === undefined, `无效的 MCP 服务器：未知字段 ${unknownKey}`);

  const { id, name, transport, enabled } = record;
  check(id === undefined || isRegistryId(id), '无效的 MCP 服务器 id');
  check(typeof name === 'string' && name.trim() !== '', '名称不能为空');
  check(name.trim().length <= MAX_NAME_LENGTH, `名称最多 ${MAX_NAME_LENGTH} 个字符`);
  check(typeof transport === 'string' && Object.hasOwn(TRANSPORTS, transport), '不支持的传输方式');
  check(typeof enabled === 'boolean', 'enabled 必须是布尔值');
  const common = { ...(id === undefined ? {} : { id }), name: name.trim() };

  if (transport === 'stdio') {
    check(record.url === undefined, 'stdio 服务器不能设置 URL');
    check(record.headers === undefined, 'stdio 服务器不能设置 Header，请改用环境变量');
    const { command } = record;
    check(typeof command === 'string' && command.trim() !== '', 'stdio 服务器需要填写命令');
    check(command.trim().length <= MAX_COMMAND_LENGTH, '命令过长');
    const args = readArgs(record.args);
    const env = readSecretFields(record.env, '环境变量');
    return {
      ...common,
      transport,
      command: command.trim(),
      ...(args === undefined ? {} : { args }),
      enabled,
      ...(env === undefined ? {} : { env }),
    };
  }

  check(record.command === undefined && record.args === undefined, '远程服务器不能设置命令');
  check(record.env === undefined, '远程服务器不能设置环境变量，请改用 Header');
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  check(url.length <= MAX_URL_LENGTH && isHttpUrl(url), 'URL 必须是 http(s) 地址');
  const headers = readSecretFields(record.headers, 'Header');
  return {
    ...common,
    transport: transport as 'sse' | 'http',
    url,
    enabled,
    ...(headers === undefined ? {} : { headers }),
  };
}

function readArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  check(Array.isArray(value) && value.length <= MAX_ARGS, '参数必须是字符串数组');
  check(
    value.every((arg) => typeof arg === 'string' && arg.length <= MAX_ARG_LENGTH),
    '参数必须是字符串数组'
  );
  return [...value];
}

function readSecretFields(value: unknown, label: string): SecretFieldInput[] | undefined {
  if (value === undefined) return undefined;
  check(Array.isArray(value) && value.length <= MAX_FIELDS, `${label}必须是数组`);
  const seen = new Set<string>();
  return value.map((item): SecretFieldInput => {
    const field = asRecord(item);
    check(field, `${label}的每一项必须是对象`);
    check(
      Object.keys(field).every((key) => FIELD_KEYS.has(key)),
      `${label}的每一项只能有 key / value`
    );
    const key = typeof field.key === 'string' ? field.key.trim() : '';
    check(
      key !== '' && key.length <= MAX_FIELD_KEY_LENGTH && !/\s/.test(key),
      `${label}的键不能为空或含空白`
    );
    check(!seen.has(key), `${label} ${key} 重复`);
    seen.add(key);
    const { value: fieldValue } = field;
    if (fieldValue === undefined) return { key };
    check(
      typeof fieldValue === 'string' && fieldValue.length <= MAX_FIELD_VALUE_LENGTH,
      `${label} ${key} 的值必须是字符串`
    );
    return { key, value: fieldValue };
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
