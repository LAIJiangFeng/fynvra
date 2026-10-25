import { asRecord } from '@shared/guards';
import type { McpImportSource, McpServerEntry } from '@shared/types/llm';
import { translate } from '../../../../i18n';
import { parseJsonc } from '../jsonc';

// 读取器：把各来源的原始内容（文件文本 / 数据库行）解释成 MCP 服务器。纯函数，不碰文件系统与 process.env；
// 内容坏了返回空并记 warning。warning 只写位置（文件、行号）与名称，不带原文：这些配置里有 env / header 的值。

/** 从其他应用配置里读到的一个 MCP 服务器。env / headers 是明文，只在 Main 里流转。 */
export interface ImportedMcpServer {
  name: string;
  transport: McpServerEntry['transport'];
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** 读取器的产出：服务器，以及它来自哪里、在来源里是否启用。 */
export interface DiscoveredMcpServer extends ImportedMcpServer {
  source: McpImportSource;
  /** 如「Claude Code」「Claude Code · fynvra」「CC Switch · Claude、Codex」 */
  sourceLabel: string;
  enabledInSource: boolean;
}

export interface ReaderResult {
  servers: DiscoveredMcpServer[];
  warnings: string[];
}

/** 一个配置文件：file 是路径（只用在 warning 里），text 是内容（已去掉 BOM）。 */
export interface SourceFile {
  file: string;
  text: string;
}

/** 环境变量（Codex 的 env_vars 等指向这里）。由调用方传入，读取器不直接读 process.env。 */
export type Env = Readonly<Record<string, string | undefined>>;

/** 字符串去首尾空白；其它类型一律当作没填。 */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 只留字符串值（env / headers）。 */
export function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value) ?? {})) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

/** type / transport 字段 → 传输方式；没写或认不出时有 url 算 http（Streamable HTTP），否则 stdio。 */
export function toTransport(raw: unknown, hasUrl: boolean): McpServerEntry['transport'] {
  const value = text(raw).toLowerCase();
  if (value === 'sse') return 'sse';
  if (['http', 'streamable-http', 'streamablehttp', 'streamable_http'].includes(value)) {
    return 'http';
  }
  if (value === 'stdio') return 'stdio';
  return hasUrl ? 'http' : 'stdio';
}

export function stdioServer(
  name: string,
  command: string,
  args: readonly string[],
  env: Record<string, string>
): ImportedMcpServer {
  return {
    name,
    transport: 'stdio',
    command,
    ...(args.length > 0 ? { args: [...args] } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function remoteServer(
  name: string,
  transport: 'sse' | 'http',
  url: string,
  headers: Record<string, string>
): ImportedMcpServer {
  return {
    name,
    transport,
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Claude 风格的一条配置 `{ type, command, args, env, url, headers }`（Claude Code、Cursor、VS Code、CC Switch 同形）。
 * 缺传输方式要求的字段（stdio 的 command / 远程的 url）返回 null。
 */
export function readServerConfig(name: string, raw: unknown): ImportedMcpServer | null {
  const config = asRecord(raw);
  if (!config) return null;
  const command = text(config.command);
  const url = text(config.url);
  const transport = toTransport(config.type ?? config.transport, url !== '');
  if (transport === 'stdio') {
    return command
      ? stdioServer(name, command, stringArray(config.args), stringRecord(config.env))
      : null;
  }
  return url ? remoteServer(name, transport, url, stringRecord(config.headers)) : null;
}

/** 来源里用 `disabled: true` 或 `enabled: false` 停用的条目。 */
export function isSwitchedOff(raw: unknown): boolean {
  const config = asRecord(raw);
  return config?.disabled === true || config?.enabled === false;
}

/**
 * `{ <名称>: <配置> }` 形状的服务器表 → 服务器。读不出的条目记 warning（只写名称）。
 * `read` 默认按 Claude 格式；`enabled` 默认看 disabled / enabled 字段。
 */
export function readServerMap(
  raw: unknown,
  meta: { source: McpImportSource; sourceLabel: string },
  warnings: string[],
  options: {
    read?: (name: string, config: unknown) => ImportedMcpServer | null;
    enabled?: (name: string, config: unknown) => boolean;
  } = {}
): DiscoveredMcpServer[] {
  const { read = readServerConfig, enabled = (_name, config) => !isSwitchedOff(config) } = options;
  const servers: DiscoveredMcpServer[] = [];
  for (const [name, config] of Object.entries(asRecord(raw) ?? {})) {
    const server = read(name, config);
    if (!server) {
      warnings.push(
        translate('importers.noCommandOrUrl', { subject: `${meta.sourceLabel} · ${name}` })
      );
      continue;
    }
    servers.push({ ...server, ...meta, enabledInSource: enabled(name, config) });
  }
  return servers;
}

/**
 * JSON / JSONC 文件的顶层对象。语法错误记 warning（只有文件与行号）；空文件当作没有配置；顶层不是对象也记 warning。
 */
export function readJsonObject(
  source: SourceFile,
  label: string,
  warnings: string[]
): Record<string, unknown> | null {
  const parsed = parseJsonc(source.text);
  if (!parsed.ok) {
    warnings.push(
      parsed.line === undefined
        ? translate('importers.invalidJson', { subject: label, file: source.file })
        : translate('importers.invalidJsonAt', {
            subject: label,
            file: source.file,
            line: parsed.line,
          })
    );
    return null;
  }
  if (parsed.value === undefined) return null;
  const record = asRecord(parsed.value);
  if (!record) {
    warnings.push(translate('importers.notJsonObject', { subject: label, file: source.file }));
  }
  return record;
}
