import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { errorMessage } from '@shared/guards';
import type { McpImportCandidate, McpImportSource } from '@shared/types/llm';
import type { McpUpsertInput, SecretFieldInput } from '../../../../preload/domains/mcp';
import { mcpDedupeKey, type StoredMcpServer } from '../mcpRegistry';
import { MAX_NAME_LENGTH, parseMcpUpsert } from '../parseMcpInput';
import { locateMcpSources, readCcSwitchMcpRows, readTextIfExists } from './locate';
import { readCcSwitch } from './readers/ccSwitch';
import { readClaudeCode } from './readers/claudeCode';
import { readCodex, readGrok } from './readers/codex';
import type {
  DiscoveredMcpServer,
  Env,
  ImportedMcpServer,
  ReaderResult,
  SourceFile,
} from './readers/common';
import { readCursor } from './readers/cursor';
import { readGemini } from './readers/gemini';
import { readOpenCode } from './readers/opencode';
import { readVsCode } from './readers/vscode';

// 「从本机导入」分三层：定位（locate.ts）→ 读取（readers/，纯函数）→ 编排去重（本文件）。
// 各来源并行读取；单个来源（或它的一个文件）失败只变成一条 warning，不影响其它来源。

/** 全部来源。顺序就是去重的优先级：规整后的命令 + 参数 / URL 相同的候选保留排在前面的。 */
export const MCP_IMPORT_SOURCES: readonly McpImportSource[] = [
  'claude-code',
  'codex',
  'grok',
  'gemini',
  'cursor',
  'vscode',
  'opencode',
  'cc-switch',
];

const SOURCE_LABELS: Readonly<Record<McpImportSource, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok CLI',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  vscode: 'VS Code',
  opencode: 'OpenCode',
  'cc-switch': 'CC Switch',
};

/** 读配置文件的来源；CC Switch 读的是数据库行，单独处理。 */
const FILE_READERS: Readonly<
  Record<
    Exclude<McpImportSource, 'cc-switch'>,
    (files: readonly SourceFile[], env: Env) => ReaderResult
  >
> = {
  'claude-code': readClaudeCode,
  codex: readCodex,
  grok: readGrok,
  gemini: readGemini,
  cursor: readCursor,
  vscode: readVsCode,
  opencode: readOpenCode,
};

export function isMcpImportSource(value: unknown): value is McpImportSource {
  return (MCP_IMPORT_SOURCES as readonly unknown[]).includes(value);
}

export interface ScannedMcpCandidate {
  /** 给 Renderer 的脱敏视图 */
  view: McpImportCandidate;
  /** 已按 mcp:upsert 的规则校验过的服务器（含 env / headers 明文），导入时直接用 */
  server: ImportedMcpServer;
}

export interface McpImportScan {
  candidates: ScannedMcpCandidate[];
  warnings: string[];
}

export interface McpScanOptions {
  /** 已登记的服务器，用来标出重复 */
  existing?: readonly StoredMcpServer[];
  home?: string;
  /** Codex 的 env_vars 等从这里取值；也决定 VS Code（APPDATA）与 OpenCode（XDG_CONFIG_HOME）的位置 */
  env?: Env;
  platform?: NodeJS.Platform;
  /** CC Switch 库副本放的临时目录 */
  tempDir?: string;
}

/** 扫描本机配置（只读）。`sources` 缺省为全部来源，传入的顺序不影响结果顺序。 */
export async function scanMcpImports(
  sources: readonly McpImportSource[] = MCP_IMPORT_SOURCES,
  options: McpScanOptions = {}
): Promise<McpImportScan> {
  const {
    existing = [],
    home = homedir(),
    env = process.env,
    platform = process.platform,
    tempDir = tmpdir(),
  } = options;
  const paths = locateMcpSources({ home, env, platform });
  const selected = MCP_IMPORT_SOURCES.filter((source) => sources.includes(source));
  const results = await Promise.all(
    selected.map((source) =>
      readSource(source, paths[source], env, tempDir).catch(
        (error): ReaderResult => ({
          servers: [],
          warnings: [`${SOURCE_LABELS[source]}：读取失败（${errorMessage(error)}）`],
        })
      )
    )
  );
  const warnings = results.flatMap((result) => result.warnings);
  const discovered = results.flatMap((result) => result.servers);
  return { candidates: toCandidates(discovered, existing, warnings), warnings };
}

async function readSource(
  source: McpImportSource,
  paths: readonly string[],
  env: Env,
  tempDir: string
): Promise<ReaderResult> {
  if (source === 'cc-switch') {
    const rows: Record<string, unknown>[] = [];
    for (const path of paths) rows.push(...((await readCcSwitchMcpRows(path, tempDir)) ?? []));
    return readCcSwitch(rows);
  }
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  for (const file of paths) {
    try {
      const text = await readTextIfExists(file);
      if (text !== null) files.push({ file, text });
    } catch (error) {
      warnings.push(`${SOURCE_LABELS[source]}：读取 ${file} 失败（${errorMessage(error)}）`);
    }
  }
  if (files.length === 0) return { servers: [], warnings };
  const result = FILE_READERS[source](files, env);
  return { servers: result.servers, warnings: [...warnings, ...result.warnings] };
}

/**
 * 校验并去重：每个候选按 mcp:upsert 的规则校验（不合规的跳过并记 warning），所以列出来的都能导入；
 * 与已登记的服务器相同的标 existing，与排在前面的候选相同的标 candidate（mcpDedupeKey）。
 */
function toCandidates(
  discovered: readonly DiscoveredMcpServer[],
  existing: readonly StoredMcpServer[],
  warnings: string[]
): ScannedMcpCandidate[] {
  const existingNames = new Map(existing.map((server) => [mcpDedupeKey(server), server.name]));
  const earlier = new Map<string, string>();
  const candidates: ScannedMcpCandidate[] = [];

  for (const found of discovered) {
    const parsed = parseMcpUpsert(toUpsertInput(found));
    if (!parsed.ok) {
      warnings.push(`${found.sourceLabel} · ${found.name}：${parsed.error}，已跳过`);
      continue;
    }
    const reference = referenceWarning(found);
    if (reference) warnings.push(reference);
    const server = fromUpsertInput(parsed.input);
    const key = mcpDedupeKey(server);
    const existingName = existingNames.get(key);
    const earlierLabel = earlier.get(key);
    if (existingName === undefined && earlierLabel === undefined) {
      earlier.set(key, `${found.sourceLabel} · ${server.name}`);
    }
    candidates.push({
      // 逐字段构造（不是展开 server 再删 env / headers），明文不可能被带进视图
      view: {
        id: randomUUID(),
        source: found.source,
        sourceLabel: found.sourceLabel,
        name: server.name,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.url ? { url: server.url } : {}),
        envKeys: Object.keys(server.env ?? {}),
        headerKeys: Object.keys(server.headers ?? {}),
        enabledInSource: found.enabledInSource,
        ...(existingName !== undefined
          ? { duplicate: 'existing', duplicateOf: existingName }
          : earlierLabel !== undefined
            ? { duplicate: 'candidate', duplicateOf: earlierLabel }
            : {}),
      },
      server,
    });
  }
  return candidates;
}

const fields = (record: Record<string, string>): SecretFieldInput[] =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

/** 读到的服务器 → 新建且启用的 mcp:upsert 入参；名称过长时截断。 */
function toUpsertInput(found: DiscoveredMcpServer): McpUpsertInput {
  const name = found.name.trim().slice(0, MAX_NAME_LENGTH);
  if (found.transport === 'stdio') {
    return {
      name,
      transport: 'stdio',
      command: found.command ?? '',
      ...(found.args?.length ? { args: found.args } : {}),
      enabled: true,
      ...(found.env ? { env: fields(found.env) } : {}),
    };
  }
  return {
    name,
    transport: found.transport,
    url: found.url ?? '',
    enabled: true,
    ...(found.headers ? { headers: fields(found.headers) } : {}),
  };
}

function fromUpsertInput(input: McpUpsertInput): ImportedMcpServer {
  const record = (list: readonly SecretFieldInput[] = []) =>
    Object.fromEntries(list.map(({ key, value }) => [key, value ?? '']));
  const env = record(input.env);
  const headers = record(input.headers);
  return {
    name: input.name,
    transport: input.transport,
    ...(input.command ? { command: input.command } : {}),
    ...(input.args?.length ? { args: [...input.args] } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** `${VAR}`、`${input:…}`（VS Code）、`{env:VAR}` / `{file:…}`（OpenCode）这类引用，fynvra 不会展开。 */
const VARIABLE_REFERENCE = /\$\{[^}]*\}|\{(?:env|file):[^}]*\}/;

/** 哪些地方引用了变量（只写键名，不写值）；没有返回 null。 */
function referenceWarning(found: DiscoveredMcpServer): string | null {
  const keysWithReference = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {})
      .filter(([, value]) => VARIABLE_REFERENCE.test(value))
      .map(([key]) => key);
  const places = [
    ...keysWithReference(found.env).map((key) => `环境变量 ${key}`),
    ...keysWithReference(found.headers).map((key) => `Header ${key}`),
    ...([found.command ?? '', ...(found.args ?? [])].some((arg) => VARIABLE_REFERENCE.test(arg))
      ? ['命令参数']
      : []),
    ...(VARIABLE_REFERENCE.test(found.url ?? '') ? ['URL'] : []),
  ];
  return places.length > 0
    ? `${found.sourceLabel} · ${found.name}：${places.join('、')} 引用了变量，fynvra 不会展开，导入后请在编辑里改成实际值`
    : null;
}
