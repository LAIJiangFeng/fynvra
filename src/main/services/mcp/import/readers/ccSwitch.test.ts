import { describe, expect, it } from 'vitest';
import { type CcSwitchMcpRow, ccSwitchMcpRows, NODE_REPL, PENCIL_EXE, SECRETS } from '../fixtures';
import { readCcSwitch } from './ccSwitch';

/** node:sqlite 读出的行：BOOLEAN 列是 0 / 1，其余是字符串或 null。 */
const asDbRows = (rows: readonly CcSwitchMcpRow[]) =>
  rows.map((row) => ({
    description: null,
    homepage: null,
    docs: null,
    tags: '[]',
    enabled_claude: 0,
    enabled_codex: 0,
    enabled_gemini: 0,
    enabled_opencode: 0,
    enabled_hermes: 0,
    ...row,
  }));

describe('readCcSwitch', () => {
  it('本机格式：server_config 同 Claude 格式；标签列出已启用的应用，一个都没启用的标为未启用', () => {
    const { servers, warnings } = readCcSwitch(asDbRows(ccSwitchMcpRows));
    expect(warnings).toEqual([]);
    expect(
      servers.map(({ name, sourceLabel, enabledInSource }) => [name, sourceLabel, enabledInSource])
    ).toEqual([
      ['chrome-devtools', 'CC Switch · Claude', true],
      ['context7', 'CC Switch · Claude', true],
      ['node_repl', 'CC Switch · Codex', true],
      ['memory', 'CC Switch · Codex', true],
      ['playwright', 'CC Switch · Codex', true],
      ['shadcn', 'CC Switch · Codex', true],
      ['github', 'CC Switch · Codex', true],
      ['pencil', 'CC Switch · Claude、Codex、Gemini、OpenCode', true],
      ['fetch', 'CC Switch', false],
    ]);
    const byName = new Map(servers.map((server) => [server.name, server]));
    expect(byName.get('context7')).toEqual({
      source: 'cc-switch',
      sourceLabel: 'CC Switch · Claude',
      name: 'context7',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      enabledInSource: true,
    });
    expect(byName.get('node_repl')).toMatchObject({
      command: NODE_REPL('1b23c930bdf84ed6'),
      env: { CODEX_HOME: 'C:\\Users\\me\\.codex', NODE_REPL_TRUSTED_SECRET: SECRETS.ccSwitchRepl },
    });
    expect(byName.get('pencil')).toMatchObject({ command: PENCIL_EXE });
  });

  it('server_config 坏了只跳过那一行（不带原文）；缺命令或 URL 的说明原因；没有名称时用 id', () => {
    const rows = asDbRows([
      { id: 'bad', name: 'bad', server_config: '{"env": {"K": "sk-should-not-leak"' },
      { id: 'empty', name: 'empty', server_config: '{"type": "stdio"}', enabled_claude: 1 },
      { id: 'from-id', name: '', server_config: '{"url": "https://x.example.com/mcp"}' },
    ]);
    const result = readCcSwitch(rows);
    expect(result.warnings).toEqual([
      'CC Switch · bad：server_config 不是有效的 JSON，已跳过',
      'CC Switch · empty：没有命令或 URL，已跳过',
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-should-not-leak');
    expect(result.servers.map(({ name, transport }) => [name, transport])).toEqual([
      ['from-id', 'http'],
    ]);
  });

  it('SQLite 的 BOOLEAN 列兼容 0 / 1、1n、true、"1"；认不出的 enabled_* 列按列名显示', () => {
    const base = { id: 'a', name: 'a', server_config: '{"command": "a"}' };
    const label = (flags: Record<string, unknown>) =>
      readCcSwitch([{ ...base, ...flags }]).servers[0]?.sourceLabel;
    expect(label({ enabled_claude: 1n, enabled_codex: true, enabled_gemini: '1' })).toBe(
      'CC Switch · Claude、Codex、Gemini'
    );
    expect(label({ enabled_hermes: 1, enabled_qwen: 1, enabled_claude: 0 })).toBe(
      'CC Switch · Hermes、qwen'
    );
    expect(label({ enabled_claude: '0', enabled_codex: false })).toBe('CC Switch');
  });
});
