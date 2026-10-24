// 测试用的本机配置：格式照 Task 15 任务书（验收人在本机核对过的实际格式），key 全是假的。
// 只被 *.test.ts 引用，不进产物。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEYS = {
  claudeCode: 'sk-fake-claude-code-token-1111',
  codex: 'sk-fake-codex-auth-key-2222',
  cursor: 'sk-fake-cc-switch-cursor-3333',
  jun: 'sk-fake-cc-switch-jun-4444',
  sub2api: 'sk-fake-cc-switch-sub2api-5555',
  gemini: 'fake-gemini-api-key-6666',
} as const;

/** ~/.claude/settings.json：中转地址带末尾 `/`，`model` 是别名，默认模型写在 env 里。 */
export const claudeSettingsJson = JSON.stringify(
  {
    env: {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable 5.1',
      ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: '公司中转默认模型',
      ANTHROPIC_AUTH_TOKEN: KEYS.claudeCode,
      ANTHROPIC_BASE_URL: 'https://relay.example.com/',
    },
    permissions: { allow: ['Bash(git status)'] },
    model: 'fable',
    enabledPlugins: {},
    skipDangerousModePermissionPrompt: true,
  },
  null,
  2
);

/** ~/.codex/config.toml：CC Switch 写出的自定义服务，key 在 auth.json。 */
export const codexConfigToml = `model_provider = "custom"
model = "gpt-6-astra"
preferred_auth_method = "apikey"
model_reasoning_effort = "high"
disable_response_storage = true
notify = ["node", "C:\\\\Users\\\\me\\\\.codex\\\\notify.js"]

[model_providers.custom]
name = "custom"
base_url = "http://10.0.0.5:8080/"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true

[projects.'C:\\Users\\me']
trust_level = "trusted"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
`;

export const codexAuthJson = JSON.stringify({ OPENAI_API_KEY: KEYS.codex }, null, 2);

/** CC Switch 存的 Codex 配置：config 是 TOML 字符串。 */
export function ccSwitchCodexConfig(model: string, baseUrl: string): string {
  return `model_provider = "custom"
model = "${model}"
model_reasoning_effort = "max"

[model_providers.custom]
name = "custom"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true
`;
}

/** cc-switch.db 的 providers 表的一行（列名与类型照本机实际的库）。 */
export interface CcSwitchFixtureRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  website_url?: string | null;
  category?: string | null;
  meta?: string;
  is_current?: 0 | 1;
}

/**
 * 本机 CC Switch 的典型内容：当前的 Codex（与 ~/.codex 同一地址与 key）、opencode、几个 Claude 中转（当前那个与
 * ~/.claude/settings.json 相同）、Claude Desktop 与 Google 官方空占位、一个 Gemini 中转。
 */
export const ccSwitchRows: CcSwitchFixtureRow[] = [
  {
    id: 'default',
    app_type: 'codex',
    name: 'default',
    settings_config: JSON.stringify({
      auth: { OPENAI_API_KEY: KEYS.codex },
      config: ccSwitchCodexConfig('gpt-6.1-sol', 'http://10.0.0.5:8080/'),
    }),
    category: 'custom',
    meta: JSON.stringify({ commonConfigEnabled: true, apiFormat: 'openai_responses' }),
    is_current: 1,
  },
  {
    id: 'default',
    app_type: 'opencode',
    name: 'default',
    settings_config: JSON.stringify({ mcp: { pencil: { type: 'local', enabled: true } } }),
    category: 'custom',
    meta: '{}',
    is_current: 1,
  },
  {
    id: '6d1f3c2a-cursor',
    app_type: 'claude',
    name: 'cursor',
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: KEYS.cursor,
        ANTHROPIC_BASE_URL: 'https://cursor-relay.example.com/',
      },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify' }] }] },
      model: 'opus[1m]',
    }),
    meta: JSON.stringify({ endpointAutoSelect: true }),
    is_current: 0,
  },
  {
    id: 'claude-desktop-official',
    app_type: 'claude-desktop',
    name: 'Claude Desktop Official',
    settings_config: JSON.stringify({ env: {} }),
    website_url: 'https://claude.ai',
    category: 'official',
    meta: '{}',
    is_current: 0,
  },
  {
    id: 'google-official',
    app_type: 'gemini',
    name: 'Google Official',
    settings_config: JSON.stringify({ env: {}, config: {} }),
    website_url: 'https://ai.google.dev',
    category: 'official',
    meta: '{}',
    is_current: 0,
  },
  {
    id: '0b9e-sub2api',
    app_type: 'codex',
    name: 'sub2api',
    settings_config: JSON.stringify({
      auth: { OPENAI_API_KEY: KEYS.sub2api },
      config: ccSwitchCodexConfig('gpt-5.5', 'http://10.0.0.9:3000/'),
    }),
    website_url: 'https://sub2api.example.com',
    meta: JSON.stringify({ apiFormat: 'openai_responses' }),
    is_current: 0,
  },
  {
    id: '7c55-jun',
    app_type: 'claude',
    name: '君',
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: KEYS.jun,
        ANTHROPIC_BASE_URL: 'https://jun.example.com/',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
      },
    }),
    meta: JSON.stringify({ apiFormat: 'anthropic' }),
    is_current: 0,
  },
  {
    id: 'a1b2-company',
    app_type: 'claude',
    name: '公司中转claude',
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: KEYS.claudeCode,
        ANTHROPIC_BASE_URL: 'https://relay.example.com/',
      },
    }),
    meta: JSON.stringify({ apiFormat: 'anthropic' }),
    is_current: 1,
  },
  {
    id: 'f00d-gemini',
    app_type: 'gemini',
    name: 'Gemini 中转',
    settings_config: JSON.stringify({
      env: {
        GEMINI_API_KEY: KEYS.gemini,
        GOOGLE_GEMINI_BASE_URL: 'https://gemini-relay.example.com',
        GEMINI_MODEL: 'gemini-pro-latest',
      },
      config: {},
    }),
    meta: '{}',
    is_current: 1,
  },
];

export const PROVIDERS_TABLE = `CREATE TABLE providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  category TEXT,
  created_at INTEGER,
  sort_index INTEGER,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT 0,
  in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
  cost_multiplier TEXT,
  limit_daily_usd TEXT,
  limit_monthly_usd TEXT,
  provider_type TEXT,
  PRIMARY KEY (id, app_type)
)`;

type Sqlite = typeof import('node:sqlite');
let sqlite: Promise<Sqlite> | null = null;

/**
 * node:sqlite 在 Node 23 上首次加载会打 ExperimentalWarning（Electron 45 的 Node 24.22 不会）。
 * 测试里先经这里加载并只静默这一条；之后被测代码再 import 拿到的是同一个已加载的模块，不会再打。
 */
export function loadSqlite(): Promise<Sqlite> {
  sqlite ??= (async () => {
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const message = typeof warning === 'string' ? warning : warning.message;
      if (message.includes('SQLite')) return;
      (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } finally {
      process.emitWarning = emitWarning;
    }
  })();
  return sqlite;
}

/** 写一个 cc-switch.db（rollback journal 模式，与本机一致）。返回库文件路径。 */
export async function writeCcSwitchDb(
  path: string,
  rows: readonly CcSwitchFixtureRow[]
): Promise<string> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(PROVIDERS_TABLE);
    insertRows(db, rows);
  } finally {
    db.close();
  }
  return path;
}

export function insertRows(
  db: InstanceType<Sqlite['DatabaseSync']>,
  rows: readonly CcSwitchFixtureRow[]
): void {
  const insert = db.prepare(
    `INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [index, row] of rows.entries()) {
    insert.run(
      row.id,
      row.app_type,
      row.name,
      row.settings_config,
      row.website_url ?? null,
      row.category ?? null,
      row.meta ?? '{}',
      row.is_current ?? 0,
      1_760_000_000_000 + index
    );
  }
}

/** 在 home 下写出三个来源的配置；传 null 的来源不写。 */
export async function writeFakeHome(
  home: string,
  files: {
    claudeSettings?: string | null;
    codexConfig?: string | null;
    codexAuth?: string | null;
    ccSwitchRows?: readonly CcSwitchFixtureRow[] | null;
  }
): Promise<void> {
  const write = (relative: string[], content: string) => {
    const path = join(home, ...relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  if (files.claudeSettings) write(['.claude', 'settings.json'], files.claudeSettings);
  if (files.codexConfig) write(['.codex', 'config.toml'], files.codexConfig);
  if (files.codexAuth) write(['.codex', 'auth.json'], files.codexAuth);
  if (files.ccSwitchRows) {
    await writeCcSwitchDb(join(home, '.cc-switch', 'cc-switch.db'), files.ccSwitchRows);
  }
}
