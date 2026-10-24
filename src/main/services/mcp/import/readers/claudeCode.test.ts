import { describe, expect, it } from 'vitest';
import { claudeJson, claudeSettingsJson, PENCIL_EXE, SECRETS } from '../fixtures';
import { readClaudeCode } from './claudeCode';

const CLAUDE_JSON = 'C:/Users/me/.claude.json';
const SETTINGS = 'C:/Users/me/.claude/settings.json';
const file = (text: string, path = CLAUDE_JSON) => ({ file: path, text });

describe('readClaudeCode', () => {
  it('本机格式：用户级 mcpServers 与项目级 mcpServers（标签带项目目录名）；Windows 的 cmd /c npx 原样保留', () => {
    const { servers, warnings } = readClaudeCode([
      file(claudeJson),
      file(claudeSettingsJson, SETTINGS),
    ]);
    expect(warnings).toEqual([]);
    const user = { source: 'claude-code', sourceLabel: 'Claude Code', enabledInSource: true };
    expect(servers).toEqual([
      {
        ...user,
        name: 'pencil',
        transport: 'stdio',
        command: PENCIL_EXE,
        args: ['--app', 'visual_studio_code'],
      },
      {
        ...user,
        name: 'chrome-devtools',
        transport: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', 'chrome-devtools-mcp@latest'],
      },
      {
        ...user,
        name: 'context7',
        transport: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
      },
      {
        ...user,
        name: 'wechat-backup',
        transport: 'stdio',
        command: 'uv',
        args: ['run', '--directory', 'D:/project/WeChat-MCP', 'wechat-backup-mcp'],
        env: { WECHAT_BACKUP_DIR: 'D:/backup', TYPESAFE_API_KEY: SECRETS.typesafe, SANITIZE: '1' },
      },
      {
        ...user,
        sourceLabel: 'Claude Code · fynvra',
        name: 'docs',
        transport: 'http',
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: SECRETS.docsBearer },
      },
    ]);
  });

  it('settings.json 的 mcpServers 也读（现有逻辑）；type 归一化，没写时有 url 算 http；非字符串的参数与 env 值丢弃', () => {
    const settings = JSON.stringify({
      mcpServers: {
        time: { command: 'uvx', args: ['mcp-server-time', 42], env: { TZ: 'Asia/Shanghai', N: 1 } },
        events: { type: 'sse', url: 'https://a.example.com/sse' },
        stream: { type: 'streamable-http', url: 'https://a.example.com/mcp' },
        implicit: { url: 'https://a.example.com/other', headers: { 'X-Key': 'k', bad: 2 } },
      },
    });
    const { servers, warnings } = readClaudeCode([file(settings, SETTINGS)]);
    expect(warnings).toEqual([]);
    expect(
      servers.map(({ source: _s, sourceLabel: _l, enabledInSource: _e, ...rest }) => rest)
    ).toEqual([
      {
        name: 'time',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-time'],
        env: { TZ: 'Asia/Shanghai' },
      },
      { name: 'events', transport: 'sse', url: 'https://a.example.com/sse' },
      { name: 'stream', transport: 'http', url: 'https://a.example.com/mcp' },
      {
        name: 'implicit',
        transport: 'http',
        url: 'https://a.example.com/other',
        headers: { 'X-Key': 'k' },
      },
    ]);
  });

  it('坏文件只记一条 warning（文件与行号，不带原文），不影响另一个文件', () => {
    const broken = [
      '{',
      '  "mcpServers": {',
      '    "x": { "command": "node", "env": { "TOKEN": "sk-should-not-leak" } }',
      '    "y": { "command": "node" }',
      '  }',
      '}',
    ].join('\n');
    const settings = JSON.stringify({ mcpServers: { time: { command: 'uvx' } } });
    const result = readClaudeCode([file(broken), file(settings, SETTINGS)]);
    expect(result.warnings).toEqual([`Claude Code：${CLAUDE_JSON} 第 4 行不是有效的 JSON，已跳过`]);
    expect(JSON.stringify(result)).not.toContain('sk-should-not-leak');
    expect(result.servers.map((server) => server.name)).toEqual(['time']);
  });

  it('缺必需字段的条目跳过并说明；顶层不是对象记 warning；空文件当作没有配置', () => {
    const text = JSON.stringify({
      mcpServers: { broken: { type: 'stdio' }, nourl: { type: 'http' }, junk: 'x' },
      projects: { 'D:/a': { mcpServers: { bad: { args: ['x'] } } }, 'D:/b': null },
    });
    expect(readClaudeCode([file(text)])).toEqual({
      servers: [],
      warnings: [
        'Claude Code · broken：没有命令或 URL，已跳过',
        'Claude Code · nourl：没有命令或 URL，已跳过',
        'Claude Code · junk：没有命令或 URL，已跳过',
        'Claude Code · a · bad：没有命令或 URL，已跳过',
      ],
    });
    expect(readClaudeCode([file('[1, 2]')]).warnings).toEqual([
      `Claude Code：${CLAUDE_JSON} 不是 JSON 对象，已跳过`,
    ]);
    expect(readClaudeCode([file('')])).toEqual({ servers: [], warnings: [] });
  });
});
