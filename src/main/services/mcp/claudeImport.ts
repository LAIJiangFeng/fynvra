import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import type { McpServerEntry } from '@shared/types/llm';
import type { McpImportSource } from '../../../preload/domains/mcp';

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

/** Claude Code 的 MCP 配置所在：~/.claude.json（含各项目）与 ~/.claude/settings.json。 */
export function claudeConfigFiles(home: string): string[] {
  return [join(home, '.claude.json'), join(home, '.claude', 'settings.json')];
}

/**
 * 解析 `{ <name>: { type, command, args, env, url, headers } }` 形状的服务器表。
 * 未写 type 时有 url 视为 http、否则 stdio；缺必需字段（stdio 的 command / 远程的 url）的条目跳过。
 */
export function parseMcpServerMap(raw: unknown): ImportedMcpServer[] {
  const map = asRecord(raw);
  if (!map) return [];
  const servers: ImportedMcpServer[] = [];
  for (const [name, value] of Object.entries(map)) {
    const config = asRecord(value);
    if (!config) continue;
    const command = text(config.command);
    const url = text(config.url);
    const transport = toTransport(config.type ?? config.transport, url !== '');
    if (transport === 'stdio') {
      if (!command) continue;
      const args = Array.isArray(config.args)
        ? config.args.filter((arg): arg is string => typeof arg === 'string')
        : [];
      const env = stringRecord(config.env);
      servers.push({
        name,
        transport,
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
    } else {
      if (!url) continue;
      const headers = stringRecord(config.headers);
      servers.push({
        name,
        transport,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  }
  return servers;
}

/** 读一个 Claude 配置文件：顶层 mcpServers 加上 projects.<路径>.mcpServers。读不了或不是 JSON 时 reject。 */
export async function readClaudeMcpServers(file: string): Promise<ImportedMcpServer[]> {
  const content = await readFile(file, 'utf8');
  let data: Record<string, unknown> | null;
  try {
    data = asRecord(JSON.parse(content));
  } catch {
    // 不带 JSON.parse 的原始信息：V8 会在里面引用文件片段，而这个文件里可能有凭证
    throw new Error('不是合法的 JSON');
  }
  const servers = parseMcpServerMap(data?.mcpServers);
  for (const project of Object.values(asRecord(data?.projects) ?? {})) {
    servers.push(...parseMcpServerMap(asRecord(project)?.mcpServers));
  }
  return servers;
}

/** 依次读取 Claude 的两个配置文件；单个文件缺失或损坏只体现在它自己的 status 上。 */
export async function importClaudeMcp(options: {
  home: string;
}): Promise<{ servers: ImportedMcpServer[]; sources: McpImportSource[] }> {
  const servers: ImportedMcpServer[] = [];
  const sources: McpImportSource[] = [];
  for (const file of claudeConfigFiles(options.home)) {
    try {
      const found = await readClaudeMcpServers(file);
      servers.push(...found);
      sources.push({ file, status: 'found', count: found.length });
    } catch (error) {
      sources.push(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { file, status: 'not-found', count: 0 }
          : { file, status: 'error', count: 0, error: errorMessage(error) }
      );
    }
  }
  return { servers, sources };
}

function toTransport(raw: unknown, hasUrl: boolean): McpServerEntry['transport'] {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'sse') return 'sse';
  if (value === 'http' || value === 'streamable-http' || value === 'streamablehttp') return 'http';
  if (value === 'stdio') return 'stdio';
  return hasUrl ? 'http' : 'stdio';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record ?? {})) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}
