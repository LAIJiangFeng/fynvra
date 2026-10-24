// 测试用的本机配置：格式照 Task 18 任务书（验收人在本机核对过的实际格式），env / header 的值全是假的。
// 只被 *.test.ts 引用，不进产物。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSqlite } from '../../providers/import/fixtures';

export { loadSqlite };

/** 出现在 env / header 值里的假密钥：扫描与导入的返回里一个都不能有。 */
export const SECRETS = {
  typesafe: 'fake-typesafe-api-key-1111',
  docsBearer: 'Bearer fake-claude-project-token-2222',
  stitch: 'fake-goog-api-key-3333',
  github: 'ghp_fake_github_token_4444',
  geminiBearer: 'Bearer fake-gemini-header-5555',
  sqlite: 'fake-cursor-sqlite-token-6666',
  copilot: 'Bearer fake-vscode-copilot-7777',
  context7: 'fake-opencode-context7-key-8888',
  ccSwitchRepl: 'fake-cc-switch-repl-secret-9999',
  figma: 'fake-figma-oauth-token-0000',
} as const;

/** 本机 pencil 的可执行文件（Claude Code、Codex、Gemini、OpenCode、CC Switch 里是同一个）。 */
export const PENCIL_EXE =
  'c:\\Users\\me\\.vscode\\extensions\\highagency.pencildev-0.6.30\\out\\mcp-server-windows-x64.exe';
export const NODE_REPL = (hash: string) =>
  `C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\${hash}\\bin\\node_repl.exe`;

/**
 * ~/.claude.json：用户级 mcpServers（Windows 上 Claude 导出的是 `cmd /c npx …`）、项目级 mcpServers，
 * 以及大量与 MCP 无关的字段。
 */
export const claudeJson = JSON.stringify(
  {
    numStartups: 412,
    installMethod: 'native',
    mcpServers: {
      pencil: {
        type: 'stdio',
        command: PENCIL_EXE,
        args: ['--app', 'visual_studio_code'],
        env: {},
      },
      'chrome-devtools': {
        type: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', 'chrome-devtools-mcp@latest'],
        env: {},
      },
      context7: {
        type: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
        env: {},
      },
      'wechat-backup': {
        type: 'stdio',
        command: 'uv',
        args: ['run', '--directory', 'D:/project/WeChat-MCP', 'wechat-backup-mcp'],
        env: { WECHAT_BACKUP_DIR: 'D:/backup', TYPESAFE_API_KEY: SECRETS.typesafe, SANITIZE: '1' },
      },
    },
    projects: {
      'D:/project/fynvra': {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {
          docs: {
            type: 'http',
            url: 'https://docs.example.com/mcp',
            headers: { Authorization: SECRETS.docsBearer },
          },
        },
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
      },
      'C:/Users/me': { allowedTools: [], mcpServers: {}, hasTrustDialogAccepted: true },
    },
  },
  null,
  2
);

/** ~/.claude/settings.json：本机这里没有 mcpServers（现有逻辑也读它）。 */
export const claudeSettingsJson = JSON.stringify(
  {
    env: { ANTHROPIC_BASE_URL: 'https://relay.example.com/' },
    permissions: { allow: ['Bash(git status)'] },
    model: 'fable',
    enabledMcpjsonServers: [],
  },
  null,
  2
);

/**
 * ~/.codex/config.toml：子表 env / http_headers、env_vars（透传的环境变量名）、bearer_token_env_var、
 * enabled、startup_timeout_sec；CC Switch 写进来的条目带 `type = "stdio"`。
 */
export const codexConfigToml = `model_provider = "custom"
model = "gpt-6-astra"
model_reasoning_effort = "high"
notify = ["node", "C:\\\\Users\\\\me\\\\.codex\\\\notify.js"]

[model_providers.custom]
name = "custom"
base_url = "http://10.0.0.5:8080/"
wire_api = "responses"
requires_openai_auth = true

[features]
web_search = true

[mcp_servers.stitch]
url = "https://stitch.googleapis.com/mcp"

[mcp_servers.stitch.http_headers]
X-Goog-Api-Key = "${SECRETS.stitch}"

[mcp_servers.playwright]
type = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--headless"]

[mcp_servers.github]
type = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "${SECRETS.github}"

[mcp_servers.node_repl]
args = []
command = '${NODE_REPL('cfb32733c877621e')}'
env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\me\\.codex'

[mcp_servers.shadcn]
type = "stdio"
command = "npx"
args = ["shadcn@latest", "mcp"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
enabled = false

[mcp_servers.pencil]
type = "stdio"
command = '${PENCIL_EXE}'
args = ["--app", "visual_studio_code"]

[projects.'C:\\Users\\me']
trust_level = "trusted"
`;

/** 读 Codex 时用的环境变量：figma 的 bearer token 有，node_repl 要透传的那个没有。 */
export const codexEnv = { FIGMA_OAUTH_TOKEN: SECRETS.figma };

/** ~/.grok/config.toml：字段同 Codex，本机只有 shadcn（比 Codex 那份多一个 npx 的 -y）。 */
export const grokConfigToml = `model = "grok-code-fast-1"

[cli]
auto_update = false

[ui]
theme = "dark"

[mcp_servers.shadcn]
command = "npx"
args = ["-y", "shadcn@latest", "mcp"]
enabled = true
startup_timeout_sec = 90
tool_timeout_sec = 120
`;

/** ~/.gemini/settings.json：url 是 SSE、httpUrl 是 Streamable HTTP；mcp.excluded 停用了 legacy-sse。 */
export const geminiSettingsJson = JSON.stringify(
  {
    mcpServers: {
      pencil: {
        command: PENCIL_EXE,
        args: ['--app', 'visual_studio_code'],
        env: {},
        timeout: 60000,
      },
      'remote-docs': {
        httpUrl: 'https://gemini-docs.example.com/mcp',
        headers: { Authorization: SECRETS.geminiBearer },
      },
      'legacy-sse': { url: 'https://sse.example.com/sse', timeout: 5000 },
    },
    mcp: { excluded: ['legacy-sse'] },
    general: { preferredEditor: 'vscode' },
    security: { auth: { selectedType: 'oauth-personal' } },
    hooks: {},
  },
  null,
  2
);

/** ~/.cursor/mcp.json：本机是 `{}`，这份是自造的（同 Claude 格式）。 */
export const cursorMcpJson = JSON.stringify(
  {
    mcpServers: {
      linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
      sqlite: {
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', 'C:/data/app.db'],
        env: { SQLITE_TOKEN: SECRETS.sqlite },
      },
    },
  },
  null,
  2
);

/** %APPDATA%\Code\User\mcp.json：JSONC，带注释与尾逗号；顶层是 servers 与 inputs。 */
export const vscodeMcpJsonc = `{
\t// 远程服务器的 key 放在 headers 里
\t"servers": {
\t\t"github": {
\t\t\t"type": "http",
\t\t\t"url": "https://api.githubcopilot.com/mcp/",
\t\t\t"headers": { "Authorization": "${SECRETS.copilot}" },
\t\t},
\t\t/* 和 Codex 里那个是同一个，只是少了 -y */
\t\t"playwright": {
\t\t\t"type": "stdio",
\t\t\t"command": "npx",
\t\t\t"args": ["@playwright/mcp@latest", "--headless"],
\t\t},
\t},
\t"inputs": [],
}
`;

/** ~/.config/opencode/opencode.json：local 的 command 是数组（第一个元素是命令），remote 带 headers。 */
export const opencodeJson = JSON.stringify(
  {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      pencil: {
        type: 'local',
        command: [PENCIL_EXE, '--app', 'visual_studio_code'],
        enabled: true,
      },
      context7: {
        type: 'remote',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: SECRETS.context7 },
        enabled: false,
      },
      everything: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-everything'],
        environment: { LOG_LEVEL: 'debug' },
      },
    },
  },
  null,
  2
);

/** cc-switch.db 的 mcp_servers 表的一行（列名与类型照本机实际的库）。 */
export interface CcSwitchMcpRow {
  id: string;
  name: string;
  server_config: string;
  description?: string | null;
  enabled_claude?: 0 | 1;
  enabled_codex?: 0 | 1;
  enabled_gemini?: 0 | 1;
  enabled_opencode?: 0 | 1;
  enabled_hermes?: 0 | 1;
}

/**
 * 本机 CC Switch 的典型内容：context7 存的是 `npx …`（写进 Claude 配置时才加 `cmd /c`）、node_repl 的运行时目录与
 * ~/.codex 里的不同、pencil 对四个应用都启用；另加一个哪个应用都没启用的 fetch。
 */
export const ccSwitchMcpRows: CcSwitchMcpRow[] = [
  {
    id: 'chrome-devtools',
    name: 'chrome-devtools',
    server_config: JSON.stringify({
      args: ['/c', 'npx', 'chrome-devtools-mcp@latest'],
      command: 'cmd',
      env: {},
      type: 'stdio',
    }),
    enabled_claude: 1,
  },
  {
    id: 'context7',
    name: 'context7',
    server_config: JSON.stringify({
      args: ['-y', '@upstash/context7-mcp'],
      command: 'npx',
      env: {},
      type: 'stdio',
    }),
    enabled_claude: 1,
  },
  {
    id: 'node_repl',
    name: 'node_repl',
    server_config: JSON.stringify({
      type: 'stdio',
      command: NODE_REPL('1b23c930bdf84ed6'),
      env: { CODEX_HOME: 'C:\\Users\\me\\.codex', NODE_REPL_TRUSTED_SECRET: SECRETS.ccSwitchRepl },
      startup_timeout_sec: 120,
    }),
    enabled_codex: 1,
  },
  {
    id: 'memory',
    name: 'memory',
    server_config: JSON.stringify({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }),
    enabled_codex: 1,
  },
  {
    id: 'playwright',
    name: 'playwright',
    server_config: JSON.stringify({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--headless'],
    }),
    enabled_codex: 1,
  },
  {
    id: 'shadcn',
    name: 'shadcn',
    server_config: JSON.stringify({
      type: 'stdio',
      command: 'npx',
      args: ['shadcn@latest', 'mcp'],
    }),
    enabled_codex: 1,
  },
  {
    id: 'github',
    name: 'github',
    server_config: JSON.stringify({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    }),
    enabled_codex: 1,
  },
  {
    id: 'pencil',
    name: 'pencil',
    server_config: JSON.stringify({
      args: ['--app', 'visual_studio_code'],
      command: PENCIL_EXE,
      env: {},
      type: 'stdio',
    }),
    enabled_claude: 1,
    enabled_codex: 1,
    enabled_gemini: 1,
    enabled_opencode: 1,
  },
  {
    id: 'fetch',
    name: 'fetch',
    server_config: JSON.stringify({ type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
    description: '还没有同步到任何应用',
  },
];

export const MCP_SERVERS_TABLE = `CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_config TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  docs TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  enabled_claude BOOLEAN NOT NULL DEFAULT 0,
  enabled_codex BOOLEAN NOT NULL DEFAULT 0,
  enabled_gemini BOOLEAN NOT NULL DEFAULT 0,
  enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
  enabled_hermes BOOLEAN NOT NULL DEFAULT 0
)`;

type Sqlite = Awaited<ReturnType<typeof loadSqlite>>;

export function insertMcpRows(
  db: InstanceType<Sqlite['DatabaseSync']>,
  rows: readonly CcSwitchMcpRow[]
): void {
  const insert = db.prepare(
    `INSERT INTO mcp_servers (id, name, server_config, description, enabled_claude, enabled_codex,
       enabled_gemini, enabled_opencode, enabled_hermes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.name,
      row.server_config,
      row.description ?? null,
      row.enabled_claude ?? 0,
      row.enabled_codex ?? 0,
      row.enabled_gemini ?? 0,
      row.enabled_opencode ?? 0,
      row.enabled_hermes ?? 0
    );
  }
}

/** 写一个只有 mcp_servers 表的 cc-switch.db（rollback journal 模式，与本机一致）。返回库文件路径。 */
export async function writeCcSwitchMcpDb(
  path: string,
  rows: readonly CcSwitchMcpRow[]
): Promise<string> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(MCP_SERVERS_TABLE);
    insertMcpRows(db, rows);
  } finally {
    db.close();
  }
  return path;
}

export interface FakeHomeFiles {
  claudeJson?: string;
  claudeSettings?: string;
  codexConfig?: string;
  grokConfig?: string;
  geminiSettings?: string;
  cursorMcp?: string;
  vscodeMcp?: string;
  opencodeJson?: string;
  ccSwitchRows?: readonly CcSwitchMcpRow[];
}

/** VS Code 的配置在 %APPDATA% 下：测试把它指到假 home 里，扫描时经 env.APPDATA 传入。 */
export const fakeAppData = (home: string) => join(home, 'AppData', 'Roaming');

/** 在 home 下写出各来源的配置；没给的来源不写。 */
export async function writeFakeHome(home: string, files: FakeHomeFiles): Promise<void> {
  const write = (path: string, content: string | undefined) => {
    if (content === undefined) return;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  write(join(home, '.claude.json'), files.claudeJson);
  write(join(home, '.claude', 'settings.json'), files.claudeSettings);
  write(join(home, '.codex', 'config.toml'), files.codexConfig);
  write(join(home, '.grok', 'config.toml'), files.grokConfig);
  write(join(home, '.gemini', 'settings.json'), files.geminiSettings);
  write(join(home, '.cursor', 'mcp.json'), files.cursorMcp);
  write(join(fakeAppData(home), 'Code', 'User', 'mcp.json'), files.vscodeMcp);
  write(join(home, '.config', 'opencode', 'opencode.json'), files.opencodeJson);
  if (files.ccSwitchRows) {
    await writeCcSwitchMcpDb(join(home, '.cc-switch', 'cc-switch.db'), files.ccSwitchRows);
  }
}

/** 本机 8 个来源都在。 */
export const ALL_SOURCES: FakeHomeFiles = {
  claudeJson,
  claudeSettings: claudeSettingsJson,
  codexConfig: codexConfigToml,
  grokConfig: grokConfigToml,
  geminiSettings: geminiSettingsJson,
  cursorMcp: cursorMcpJson,
  vscodeMcp: vscodeMcpJsonc,
  opencodeJson,
  ccSwitchRows: ccSwitchMcpRows,
};
