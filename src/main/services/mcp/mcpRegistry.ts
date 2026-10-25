import { asRecord } from '@shared/guards';
import type { McpServerEntry, McpServerEntryView } from '@shared/types/llm';
import type { McpUpsertInput, SecretFieldInput } from '../../../preload/domains/mcp';
import { translate } from '../../i18n';
import { createJsonRegistry, isRegistryId, toSlug, uniqueId } from '../providers/jsonRegistry';
import type { ImportedMcpServer } from './import/readers/common';
import { MAX_NAME_LENGTH } from './parseMcpInput';

/** mcp.json 里的一条记录：§9.6 的 McpServerEntry 加 env / headers 明文。只存在于 Main。 */
export interface StoredMcpServer extends McpServerEntry {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export type McpUpsertOutcome = { ok: true; server: StoredMcpServer } | { ok: false; error: string };
/** 导入一条的结果；失败时 error 说明与谁重复。 */
export type McpAddOutcome = McpUpsertOutcome;

export interface McpRegistry {
  /** 全部服务器（含 env / headers 明文），仅供 Main；给 Renderer 的一律经 toMcpServerView。 */
  list(): Promise<StoredMcpServer[]>;
  get(id: string): Promise<StoredMcpServer | undefined>;
  /** 入参须先经 parseMcpUpsert。无 id 为新建，有 id 为整条替换，env / headers 按 SecretFieldInput 规则合并。 */
  upsert(input: McpUpsertInput): Promise<McpUpsertOutcome>;
  /**
   * 导入：与已登记的或本批更早的服务器（按 mcpDedupeKey）相同就跳过并说明与谁相同；名称被占用（不分大小写）
   * 时加「 (2)」「 (3)」…；新增的默认启用。结果与入参一一对应，一条都没新增时不写盘。
   */
  addMany(servers: readonly ImportedMcpServer[]): Promise<McpAddOutcome[]>;
  setEnabled(id: string, enabled: boolean): Promise<StoredMcpServer | undefined>;
  remove(id: string): Promise<boolean>;
}

/** `userData/mcp.json`：MCP 服务器与 env / headers 明文，原子写。 */
export function createMcpRegistry(options: { filePath: string; now?: () => number }): McpRegistry {
  const registry = createJsonRegistry<StoredMcpServer>({
    ...options,
    key: 'servers',
    parseEntry: parseStoredMcpServer,
  });

  return {
    list: () => registry.list(),
    async get(id) {
      return (await registry.list()).find((server) => server.id === id);
    },
    upsert: (input) =>
      registry.transact((servers): { next?: StoredMcpServer[]; result: McpUpsertOutcome } => {
        const index = input.id === undefined ? -1 : servers.findIndex((s) => s.id === input.id);
        const previous = servers[index];
        if (input.id !== undefined && !previous) {
          return { result: { ok: false, error: translate('mcp.notFoundId', { id: input.id }) } };
        }
        const id =
          previous?.id ??
          uniqueId(
            toSlug(input.name, 'mcp'),
            servers.map((server) => server.id)
          );
        const server = buildServer(id, input, previous);
        if (typeof server === 'string') return { result: { ok: false, error: server } };
        const next = previous ? servers.with(index, server) : [...servers, server];
        return { next, result: { ok: true, server } };
      }),
    addMany: (imported) =>
      registry.transact((servers): { next?: StoredMcpServer[]; result: McpAddOutcome[] } => {
        const next = [...servers];
        const owners = new Map(servers.map((server) => [mcpDedupeKey(server), server.name]));
        const result = imported.map((server): McpAddOutcome => {
          const key = mcpDedupeKey(server);
          const owner = owners.get(key);
          if (owner !== undefined) {
            return {
              ok: false,
              error: translate(server.url ? 'mcp.sameUrl' : 'mcp.sameCommand', { owner }),
            };
          }
          const name = uniqueName(
            server.name.trim() || server.command || server.url || 'mcp',
            next.map((existing) => existing.name)
          );
          const entry: StoredMcpServer = {
            id: uniqueId(
              toSlug(name, 'mcp'),
              next.map((existing) => existing.id)
            ),
            name,
            transport: server.transport,
            ...(server.command ? { command: server.command } : {}),
            ...(server.args?.length ? { args: [...server.args] } : {}),
            ...(server.url ? { url: server.url } : {}),
            enabled: true,
            ...(nonEmpty(server.env) ? { env: { ...server.env } } : {}),
            ...(nonEmpty(server.headers) ? { headers: { ...server.headers } } : {}),
          };
          next.push(entry);
          owners.set(key, name);
          return { ok: true, server: entry };
        });
        return next.length > servers.length ? { next, result } : { result };
      }),
    setEnabled: (id, enabled) =>
      registry.transact((servers) => {
        const index = servers.findIndex((server) => server.id === id);
        const current = servers[index];
        if (!current) return { result: undefined };
        const updated = { ...current, enabled };
        return { next: servers.with(index, updated), result: updated };
      }),
    remove: (id) =>
      registry.transact((servers) => {
        const next = servers.filter((server) => server.id !== id);
        return next.length === servers.length ? { result: false } : { next, result: true };
      }),
  };
}

/**
 * 按传输方式组装记录：stdio 只留 command / args / env，远程只留 url / headers，切换方式时另一侧的字段
 * 与密钥一并丢弃。返回字符串表示入参错误。
 */
function buildServer(
  id: string,
  input: McpUpsertInput,
  previous: StoredMcpServer | undefined
): StoredMcpServer | string {
  if (input.transport === 'stdio') {
    const env = mergeSecrets(
      input.env,
      previous?.transport === 'stdio' ? previous.env : undefined,
      translate('mcp.env')
    );
    if (typeof env === 'string') return env;
    return {
      id,
      name: input.name,
      transport: 'stdio',
      command: input.command ?? '',
      ...(input.args?.length ? { args: [...input.args] } : {}),
      enabled: input.enabled,
      ...(nonEmpty(env) ? { env } : {}),
    };
  }
  const headers = mergeSecrets(
    input.headers,
    previous && previous.transport !== 'stdio' ? previous.headers : undefined,
    translate('mcp.header')
  );
  if (typeof headers === 'string') return headers;
  return {
    id,
    name: input.name,
    transport: input.transport,
    url: input.url ?? '',
    enabled: input.enabled,
    ...(nonEmpty(headers) ? { headers } : {}),
  };
}

/**
 * 编辑时 Renderer 拿不到明文：fields 缺省 → 沿用全部旧值；给出时就是完整的键集合，
 * 不带 value 的键沿用旧值（旧值不存在则报错），没列出的键删除。
 */
function mergeSecrets(
  fields: readonly SecretFieldInput[] | undefined,
  previous: Record<string, string> | undefined,
  label: string
): Record<string, string> | string {
  if (fields === undefined) return { ...previous };
  const merged: Record<string, string> = {};
  for (const { key, value } of fields) {
    if (value !== undefined) merged[key] = value;
    else if (previous && Object.hasOwn(previous, key)) merged[key] = previous[key] ?? '';
    else return translate('mcp.missingValue', { label, key });
  }
  return merged;
}

function nonEmpty(record: Record<string, string> | undefined): record is Record<string, string> {
  return record !== undefined && Object.keys(record).length > 0;
}

/** 名称已被占用（不分大小写）时依次尝试「name (2)」「name (3)」…，截断 name 保证总长不超过上限。 */
function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const name = base.slice(0, MAX_NAME_LENGTH);
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * 去重键：远程服务器看 URL（去首尾空白与末尾 `/`）；stdio 看规整后的命令与逐项参数：小写、`\` 换成 `/`，
 * 去掉 Windows 的 `cmd [/d /s] /c` 外壳、命令的 .cmd / .exe 后缀、npx 在包名之前的 -y / --yes。
 * Claude Code 在 Windows 上写的是 `cmd /c npx -y …`，CC Switch、Codex 存的是 `npx …`，规整后是同一个。
 */
export function mcpDedupeKey(server: {
  command?: string;
  args?: readonly string[];
  url?: string;
}): string {
  if (server.url) return `url:${server.url.trim().replace(/\/+$/, '')}`;
  return `cmd:${JSON.stringify(normalizeCommandLine([server.command ?? '', ...(server.args ?? [])]))}`;
}

const CMD_SHELL = /(?:^|\/)cmd(?:\.exe)?$/;
const CMD_SWITCH = /^\/[a-z]$/;
const NPX = /(?:^|\/)npx$/;

function normalizeCommandLine(raw: readonly string[]): string[] {
  let tokens = raw.map((token) => token.trim().toLowerCase().replaceAll('\\', '/'));
  if (CMD_SHELL.test(tokens[0] ?? '')) {
    const c = tokens.indexOf('/c');
    if (c > 0 && c < tokens.length - 1 && tokens.slice(1, c).every((t) => CMD_SWITCH.test(t))) {
      tokens = tokens.slice(c + 1);
    }
  }
  const [command = '', ...args] = tokens;
  const program = command.replace(/\.(?:cmd|exe)$/, '');
  if (!NPX.test(program)) return [program, ...args];
  const pkg = args.findIndex((arg) => !arg.startsWith('-'));
  const flags = pkg === -1 ? args : args.slice(0, pkg);
  return [
    program,
    ...flags.filter((flag) => flag !== '-y' && flag !== '--yes'),
    ...(pkg === -1 ? [] : args.slice(pkg)),
  ];
}

/** 给 Renderer 的视图：逐字段构造，env / headers 只给键名。 */
export function toMcpServerView(server: StoredMcpServer): McpServerEntryView {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.url ? { url: server.url } : {}),
    enabled: server.enabled,
    envKeys: Object.keys(server.env ?? {}),
    headerKeys: Object.keys(server.headers ?? {}),
  };
}

/** 磁盘记录宽松收窄：缺少传输方式要求的字段整条丢弃，未知字段与非字符串的密钥值丢弃。 */
export function parseStoredMcpServer(raw: unknown): StoredMcpServer | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, transport, command, url, enabled } = record;
  if (!isRegistryId(id) || typeof name !== 'string' || !name.trim()) return null;
  const base = { id, name: name.trim() };
  const isEnabled = typeof enabled === 'boolean' ? enabled : true;
  if (transport === 'stdio') {
    if (typeof command !== 'string' || !command.trim()) return null;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    const env = stringRecord(record.env);
    return {
      ...base,
      transport,
      command,
      ...(args ? { args } : {}),
      enabled: isEnabled,
      ...(nonEmpty(env) ? { env } : {}),
    };
  }
  if (transport !== 'sse' && transport !== 'http') return null;
  if (typeof url !== 'string' || !url.trim()) return null;
  const headers = stringRecord(record.headers);
  return {
    ...base,
    transport,
    url,
    enabled: isEnabled,
    ...(nonEmpty(headers) ? { headers } : {}),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value) ?? {})) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}
