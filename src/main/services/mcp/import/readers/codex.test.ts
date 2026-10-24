import { describe, expect, it } from 'vitest';
import {
  codexConfigToml,
  codexEnv,
  grokConfigToml,
  NODE_REPL,
  PENCIL_EXE,
  SECRETS,
} from '../fixtures';
import { readCodex, readGrok } from './codex';

const CODEX = 'C:/Users/me/.codex/config.toml';
const file = (text: string, path = CODEX) => ({ file: path, text });

describe('readCodex', () => {
  it('本机格式：子表 env / http_headers、env_vars 与 bearer_token_env_var 从环境变量取值、enabled = false', () => {
    const { servers, warnings } = readCodex([file(codexConfigToml)], codexEnv);
    expect(warnings).toEqual([
      'Codex · node_repl：环境变量 CODEX_WINDOWS_REGISTERED_CORE 没有设置，导入后需要在编辑里补上',
    ]);
    expect(
      servers.map(({ name, transport, enabledInSource }) => [name, transport, enabledInSource])
    ).toEqual([
      ['stitch', 'http', true],
      ['playwright', 'stdio', true],
      ['github', 'stdio', true],
      ['node_repl', 'stdio', true],
      ['shadcn', 'stdio', true],
      ['figma', 'http', false],
      ['pencil', 'stdio', true],
    ]);
    const byName = new Map(servers.map((server) => [server.name, server]));
    expect(byName.get('stitch')).toEqual({
      source: 'codex',
      sourceLabel: 'Codex',
      name: 'stitch',
      transport: 'http',
      url: 'https://stitch.googleapis.com/mcp',
      headers: { 'X-Goog-Api-Key': SECRETS.stitch },
      enabledInSource: true,
    });
    expect(byName.get('github')).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRETS.github },
    });
    expect(byName.get('node_repl')).toEqual({
      source: 'codex',
      sourceLabel: 'Codex',
      name: 'node_repl',
      transport: 'stdio',
      command: NODE_REPL('cfb32733c877621e'),
      env: { CODEX_HOME: 'C:\\Users\\me\\.codex' },
      enabledInSource: true,
    });
    expect(byName.get('figma')?.headers).toEqual({ Authorization: `Bearer ${SECRETS.figma}` });
    expect(byName.get('pencil')).toMatchObject({ command: PENCIL_EXE });
  });

  it('env_vars 也接受 { name } 写法；env 里写了的不覆盖；env_http_headers 从环境变量取 header 的值', () => {
    const toml = `[mcp_servers.tool]
command = "tool"
env_vars = ["TOKEN", { name = "REGION", source = "local" }, "MISSING"]

[mcp_servers.tool.env]
TOKEN = "literal"

[mcp_servers.remote]
url = "https://remote.example.com/mcp"
env_http_headers = { "X-Org-Id" = "ORG_ID", "X-Absent" = "ABSENT" }
http_headers = { "X-Static" = "1" }
`;
    const env = { TOKEN: 'from-env', REGION: 'cn', ORG_ID: 'org-42' };
    const { servers, warnings } = readCodex([file(toml)], env);
    expect(servers.map(({ env: e, headers }) => ({ env: e, headers }))).toEqual([
      { env: { TOKEN: 'literal', REGION: 'cn' }, headers: undefined },
      { env: undefined, headers: { 'X-Static': '1', 'X-Org-Id': 'org-42' } },
    ]);
    expect(warnings).toEqual([
      'Codex · tool：环境变量 MISSING 没有设置，导入后需要在编辑里补上',
      'Codex · remote：环境变量 ABSENT 没有设置，导入后需要在编辑里补上',
    ]);
  });

  it('坏 TOML 只给行号，不带原文；没有 mcp_servers 时没有候选也没有 warning', () => {
    const broken =
      'model = "x"\n[mcp_servers.a]\ncommand = "node"\nenv = { TOKEN = "sk-should-not-leak"\n';
    const result = readCodex([file(broken)], {});
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^Codex：C:\/Users\/me\/\.codex\/config\.toml 第 \d+ 行不是有效的 TOML，已跳过$/
      ),
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-should-not-leak');

    expect(readCodex([file('model = "gpt-6"\n')], {})).toEqual({ servers: [], warnings: [] });
  });

  it('既没有 command 也没有 url 的条目跳过并说明', () => {
    const toml = '[mcp_servers.empty]\nstartup_timeout_sec = 10\n';
    expect(readCodex([file(toml)], {})).toEqual({
      servers: [],
      warnings: ['Codex · empty：没有命令或 URL，已跳过'],
    });
  });
});

describe('readGrok', () => {
  it('字段同 Codex：本机的 shadcn（enabled、两个超时字段忽略）', () => {
    expect(readGrok([file(grokConfigToml, 'C:/Users/me/.grok/config.toml')], {})).toEqual({
      servers: [
        {
          source: 'grok',
          sourceLabel: 'Grok CLI',
          name: 'shadcn',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'shadcn@latest', 'mcp'],
          enabledInSource: true,
        },
      ],
      warnings: [],
    });
  });

  it('坏 TOML 的 warning 标明是 Grok CLI', () => {
    const result = readGrok([file('[mcp_servers\n', 'C:/Users/me/.grok/config.toml')], {});
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^Grok CLI：C:\/Users\/me\/\.grok\/config\.toml 第 1 行不是有效的 TOML，已跳过$/
      ),
    ]);
  });
});
