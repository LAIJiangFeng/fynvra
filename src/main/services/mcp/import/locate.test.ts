import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ccSwitchMcpRows,
  insertMcpRows,
  loadSqlite,
  MCP_SERVERS_TABLE,
  writeCcSwitchMcpDb,
} from './fixtures';
import { locateMcpSources, readCcSwitchMcpRows } from './locate';

let base: string;
/** 库副本放这里，便于断言读完后删干净 */
let tempRoot: string;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-mcp-locate-'));
  tempRoot = join(base, 'tmp');
  mkdirSync(tempRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('locateMcpSources', () => {
  const home = join('C:', 'Users', 'me');

  it('Windows：8 个来源各自的候选路径，VS Code 在 %APPDATA% 下（含 Insiders）', () => {
    const appData = join('D:', 'Roaming');
    expect(locateMcpSources({ home, env: { APPDATA: appData }, platform: 'win32' })).toEqual({
      'claude-code': [join(home, '.claude.json'), join(home, '.claude', 'settings.json')],
      codex: [join(home, '.codex', 'config.toml')],
      grok: [join(home, '.grok', 'config.toml')],
      gemini: [join(home, '.gemini', 'settings.json')],
      cursor: [join(home, '.cursor', 'mcp.json')],
      vscode: [
        join(appData, 'Code', 'User', 'mcp.json'),
        join(appData, 'Code - Insiders', 'User', 'mcp.json'),
      ],
      opencode: [
        join(home, '.config', 'opencode', 'opencode.json'),
        join(home, '.config', 'opencode', 'opencode.jsonc'),
      ],
      'cc-switch': [join(home, '.cc-switch', 'cc-switch.db')],
    });
    expect(locateMcpSources({ home, env: {}, platform: 'win32' }).vscode[0]).toBe(
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
    );
  });

  it('macOS 的 VS Code 在 Application Support；Linux 跟随 XDG_CONFIG_HOME（OpenCode 也是）', () => {
    expect(locateMcpSources({ home, env: {}, platform: 'darwin' }).vscode[0]).toBe(
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    );
    const xdg = join(home, 'xdg');
    const linux = locateMcpSources({ home, env: { XDG_CONFIG_HOME: xdg }, platform: 'linux' });
    expect(linux.vscode[0]).toBe(join(xdg, 'Code', 'User', 'mcp.json'));
    expect(linux.opencode[0]).toBe(join(xdg, 'opencode', 'opencode.json'));
    expect(locateMcpSources({ home, env: {}, platform: 'linux' }).vscode[1]).toBe(
      join(home, '.config', 'Code - Insiders', 'User', 'mcp.json')
    );
  });
});

describe('readCcSwitchMcpRows', () => {
  it('读出 mcp_servers 表的全部行；读的是副本，读完删除，源库一个字节都不变', async () => {
    const path = await writeCcSwitchMcpDb(join(base, 'cc', 'cc-switch.db'), ccSwitchMcpRows);
    const before = readFileSync(path);

    const rows = await readCcSwitchMcpRows(path, tempRoot);
    expect(rows).toHaveLength(ccSwitchMcpRows.length);
    expect(rows?.[0]).toMatchObject({ id: 'chrome-devtools', enabled_claude: 1, enabled_codex: 0 });
    expect(rows?.map((row) => row.name)).toContain('pencil');

    expect(readdirSync(tempRoot)).toEqual([]);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(base, 'cc'))).toEqual(['cc-switch.db']);
  });

  it('库不存在返回 null', async () => {
    expect(await readCcSwitchMcpRows(join(base, 'missing.db'), tempRoot)).toBeNull();
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('CC Switch 正开着库、新写入还在 -wal 里：读得到最新的行，也不影响它继续写', async () => {
    const { DatabaseSync } = await loadSqlite();
    const path = join(base, 'cc', 'cc-switch.db');
    mkdirSync(join(base, 'cc'));
    const live = new DatabaseSync(path);
    try {
      live.exec('PRAGMA journal_mode = WAL');
      live.exec(MCP_SERVERS_TABLE);
      insertMcpRows(live, ccSwitchMcpRows.slice(0, 3));
      expect(readdirSync(join(base, 'cc'))).toContain('cc-switch.db-wal');

      const rows = await readCcSwitchMcpRows(path, tempRoot);
      expect(rows?.map((row) => row.name)).toEqual(['chrome-devtools', 'context7', 'node_repl']);
      expect(readdirSync(tempRoot)).toEqual([]);

      insertMcpRows(live, ccSwitchMcpRows.slice(3, 4));
      expect(live.prepare('SELECT count(*) AS n FROM mcp_servers').get()).toEqual({ n: 4 });
    } finally {
      live.close();
    }
  });

  it('没有 mcp_servers 表、不是 SQLite 文件：抛错（scan 记成该来源的 warning），副本照样删除', async () => {
    const { DatabaseSync } = await loadSqlite();
    const older = join(base, 'older.db');
    const db = new DatabaseSync(older);
    db.exec('CREATE TABLE providers (id TEXT, app_type TEXT)');
    db.close();
    await expect(readCcSwitchMcpRows(older, tempRoot)).rejects.toThrow(
      '数据库里没有 mcp_servers 表'
    );

    const garbage = join(base, 'garbage.db');
    writeFileSync(garbage, 'not a database, just text\n'.repeat(200));
    await expect(readCcSwitchMcpRows(garbage, tempRoot)).rejects.toThrow();
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
