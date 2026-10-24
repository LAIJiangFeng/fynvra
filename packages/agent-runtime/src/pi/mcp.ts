import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
  type McpServerEntry,
  type McpServerConfig as PiMcpServerConfig,
} from '@earendil-works/pi-coding-agent';

/**
 * 角色挂载的一个 MCP 服务器：pi 的服务器配置加上名字。
 * pi 按名字索引服务器，工具名为 `mcp__<name>__<tool>`。
 */
export type McpServerConfig = PiMcpServerConfig & { name: string };

export interface RoleMcpPlan {
  /** 交给 DefaultResourceLoader 的扩展；没有可用服务器时为空 */
  extensions: InlineExtension[];
  /** 注入 pi 的服务器条目（已补默认 exposure） */
  servers: McpServerEntry[];
  warnings: string[];
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * 角色的 MCP 服务器 → pi 扩展。
 *
 * - 服务器经 `loadConfig` 直接注入，不读 mcp.json；`/mcp` 的修改不落盘（Main 是 MCP 配置的权威，env 明文只在 Main）。
 * - 未声明 exposure 的服务器默认 `direct`：pi 默认的 `codemode` 需要 codemode 扩展，否则工具对模型不可达。
 * - 显式用到 `codemode` / `deferred` 时加载 codemode / tool_search 扩展。
 *
 * 升级复检点：依赖 pi 1.4.0 的 `createMcpExtension({ loadConfig, updateConfig })` 与 `LoadedMcpConfig` 结构，
 * 以及 MCP 在 session_start 连接、session_shutdown 关闭的生命周期。
 */
export function createRoleMcpExtensions(servers: readonly McpServerConfig[]): RoleMcpPlan {
  const warnings: string[] = [];
  const entries: McpServerEntry[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    const { name, ...config } = server;
    if (!SERVER_NAME.test(name)) {
      warnings.push(
        `MCP server "${name}" skipped: names may contain only letters, digits, "_" and "-"`
      );
      continue;
    }
    // pi 把只差 "-" / "_" 的名字视为同一个服务器
    const key = name.replace(/-/g, '_');
    if (seen.has(key)) {
      warnings.push(`MCP server "${name}" skipped: duplicate server name`);
      continue;
    }
    seen.add(key);
    entries.push({
      name,
      config: { ...config, exposure: config.exposure ?? 'direct' } as PiMcpServerConfig,
      source: 'fynvra',
    });
  }
  if (entries.length === 0) return { extensions: [], servers: [], warnings };

  const exposures = new Set(
    entries.flatMap((entry) => [
      entry.config.exposure,
      ...Object.values(entry.config.toolExposure ?? {}),
    ])
  );
  const extensions: InlineExtension[] = [];
  if (exposures.has('codemode')) {
    extensions.push({ name: 'fynvra-codemode', hidden: true, factory: createCodemodeExtension() });
  }
  if (exposures.has('deferred')) {
    extensions.push({
      name: 'fynvra-tool-search',
      hidden: true,
      factory: createToolSearchExtension(),
    });
  }
  extensions.push({
    name: 'fynvra-mcp',
    hidden: true,
    factory: createMcpExtension({
      loadConfig: () => ({ servers: entries, errors: [] }),
      updateConfig: () => {},
    }),
  });
  return { extensions, servers: entries, warnings };
}
