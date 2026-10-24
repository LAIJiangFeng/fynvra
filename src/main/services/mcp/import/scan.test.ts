import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpImportSource } from '@shared/types/llm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredMcpServer } from '../mcpRegistry';
import {
  ALL_SOURCES,
  ccSwitchMcpRows,
  claudeJson,
  codexEnv,
  fakeAppData,
  loadSqlite,
  SECRETS,
  writeFakeHome,
} from './fixtures';
import { type McpImportScan, scanMcpImports } from './scan';

let base: string;
let home: string;
let tempRoot: string;

beforeAll(async () => {
  await loadSqlite();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'fynvra-mcp-scan-'));
  home = join(base, 'home');
  tempRoot = join(base, 'tmp');
  mkdirSync(home);
  mkdirSync(tempRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const scan = (sources?: McpImportSource[], existing: StoredMcpServer[] = []) =>
  scanMcpImports(sources, {
    existing,
    home,
    env: { ...codexEnv, APPDATA: fakeAppData(home) },
    platform: 'win32',
    tempDir: tempRoot,
  });

const summary = (candidates: McpImportScan['candidates']) =>
  candidates.map(({ view }) => [
    view.sourceLabel,
    view.name,
    view.duplicate ?? null,
    view.duplicateOf ?? null,
  ]);

describe('scanMcpImports', () => {
  it('8 个来源都在：按来源顺序排列；规整后的命令 + 参数 / URL 相同的保留排前面的', async () => {
    await writeFakeHome(home, ALL_SOURCES);
    const { candidates, warnings } = await scan();
    expect(warnings).toEqual([
      'Codex · node_repl：环境变量 CODEX_WINDOWS_REGISTERED_CORE 没有设置，导入后需要在编辑里补上',
    ]);
    const pencil = 'Claude Code · pencil';
    expect(summary(candidates)).toEqual([
      ['Claude Code', 'pencil', null, null],
      ['Claude Code', 'chrome-devtools', null, null],
      ['Claude Code', 'context7', null, null],
      ['Claude Code', 'wechat-backup', null, null],
      ['Claude Code · fynvra', 'docs', null, null],
      ['Codex', 'stitch', null, null],
      ['Codex', 'playwright', null, null],
      ['Codex', 'github', null, null],
      ['Codex', 'node_repl', null, null],
      ['Codex', 'shadcn', null, null],
      ['Codex', 'figma', null, null],
      ['Codex', 'pencil', 'candidate', pencil],
      // 比 Codex 那份多了 npx 的 -y
      ['Grok CLI', 'shadcn', 'candidate', 'Codex · shadcn'],
      ['Gemini CLI', 'pencil', 'candidate', pencil],
      ['Gemini CLI', 'remote-docs', null, null],
      ['Gemini CLI', 'legacy-sse', null, null],
      ['Cursor', 'linear', null, null],
      ['Cursor', 'sqlite', null, null],
      ['VS Code', 'github', null, null],
      ['VS Code', 'playwright', 'candidate', 'Codex · playwright'],
      ['OpenCode', 'pencil', 'candidate', pencil],
      ['OpenCode', 'context7', null, null],
      ['OpenCode', 'everything', null, null],
      ['CC Switch · Claude', 'chrome-devtools', 'candidate', 'Claude Code · chrome-devtools'],
      // CC Switch 存的是 npx …，Claude Code 里是 cmd /c npx …
      ['CC Switch · Claude', 'context7', 'candidate', 'Claude Code · context7'],
      ['CC Switch · Codex', 'node_repl', null, null],
      ['CC Switch · Codex', 'memory', null, null],
      ['CC Switch · Codex', 'playwright', 'candidate', 'Codex · playwright'],
      ['CC Switch · Codex', 'shadcn', 'candidate', 'Codex · shadcn'],
      ['CC Switch · Codex', 'github', 'candidate', 'Codex · github'],
      ['CC Switch · Claude、Codex、Gemini、OpenCode', 'pencil', 'candidate', pencil],
      ['CC Switch', 'fetch', null, null],
    ]);
    expect(
      candidates.filter(({ view }) => !view.enabledInSource).map(({ view }) => view.name)
    ).toEqual(['figma', 'legacy-sse', 'context7', 'fetch']);
    expect(new Set(candidates.map(({ view }) => view.id)).size).toBe(candidates.length);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('视图逐字段构造：env / headers 只有键名，导入用的 server 里才有值', async () => {
    await writeFakeHome(home, ALL_SOURCES);
    const { candidates } = await scan();
    const byName = (sourceLabel: string, name: string) =>
      candidates.find(({ view }) => view.sourceLabel === sourceLabel && view.name === name);

    const wechat = byName('Claude Code', 'wechat-backup');
    const args = ['run', '--directory', 'D:/project/WeChat-MCP', 'wechat-backup-mcp'];
    expect(wechat?.view).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      name: 'wechat-backup',
      transport: 'stdio',
      command: 'uv',
      args,
      envKeys: ['WECHAT_BACKUP_DIR', 'TYPESAFE_API_KEY', 'SANITIZE'],
      headerKeys: [],
      enabledInSource: true,
    });
    expect(wechat?.server).toEqual({
      name: 'wechat-backup',
      transport: 'stdio',
      command: 'uv',
      args,
      env: { WECHAT_BACKUP_DIR: 'D:/backup', TYPESAFE_API_KEY: SECRETS.typesafe, SANITIZE: '1' },
    });

    expect(byName('Codex', 'figma')?.view).toMatchObject({
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      envKeys: [],
      headerKeys: ['Authorization'],
      enabledInSource: false,
    });
    expect(byName('Codex', 'figma')?.server.headers).toEqual({
      Authorization: `Bearer ${SECRETS.figma}`,
    });

    const views = JSON.stringify(candidates.map(({ view }) => view));
    for (const secret of Object.values(SECRETS)) expect(views).not.toContain(secret);
  });

  it('与已有服务器相同的标 existing 并给出它的名称（优先于与前面候选相同）', async () => {
    await writeFakeHome(home, { claudeJson, ccSwitchRows: ccSwitchMcpRows });
    const existing: StoredMcpServer[] = [
      {
        id: 'context7',
        name: 'Context7（手动添加）',
        transport: 'stdio',
        command: 'npx',
        args: ['@upstash/context7-mcp'],
        enabled: true,
      },
      {
        id: 'docs',
        name: '文档',
        transport: 'http',
        url: 'https://docs.example.com/mcp/',
        enabled: false,
      },
    ];
    const { candidates } = await scan(undefined, existing);
    const marks = summary(candidates).filter(([, name]) => name === 'context7' || name === 'docs');
    expect(marks).toEqual([
      ['Claude Code', 'context7', 'existing', 'Context7（手动添加）'],
      ['Claude Code · fynvra', 'docs', 'existing', '文档'],
      ['CC Switch · Claude', 'context7', 'existing', 'Context7（手动添加）'],
    ]);
  });

  it('只扫一部分来源：排在前面的来源不在了，重复关系按所选来源重算；传入顺序不影响结果顺序', async () => {
    await writeFakeHome(home, ALL_SOURCES);
    const { candidates } = await scan(['cc-switch']);
    expect(candidates.every(({ view }) => view.source === 'cc-switch')).toBe(true);
    expect(candidates.some(({ view }) => view.duplicate)).toBe(false);
    expect(
      new Set(
        (await scan(['opencode', 'grok', 'claude-code'])).candidates.map((c) => c.view.source)
      )
    ).toEqual(new Set(['claude-code', 'grok', 'opencode']));
    expect((await scan(['opencode', 'claude-code'])).candidates[0]?.view.source).toBe(
      'claude-code'
    );
  });

  it('单个来源（或其中一个文件）读失败只记 warning，不影响其它来源', async () => {
    await writeFakeHome(home, {
      claudeSettings: JSON.stringify({ mcpServers: { time: { command: 'uvx' } } }),
    });
    mkdirSync(join(home, '.claude.json'));
    mkdirSync(join(home, '.cc-switch'));
    writeFileSync(join(home, '.cc-switch', 'cc-switch.db'), 'not a database\n'.repeat(300));
    mkdirSync(join(fakeAppData(home), 'Code', 'User'), { recursive: true });
    writeFileSync(
      join(fakeAppData(home), 'Code', 'User', 'mcp.json'),
      String.fromCharCode(0).repeat(315)
    );

    const { candidates, warnings } = await scan();
    expect(candidates.map(({ view }) => [view.sourceLabel, view.name])).toEqual([
      ['Claude Code', 'time'],
    ]);
    expect(warnings).toEqual([
      expect.stringMatching(/^Claude Code：读取 .+\.claude\.json 失败（.+）$/),
      `VS Code：${join(fakeAppData(home), 'Code', 'User', 'mcp.json')} 不是有效的 JSON，已跳过`,
      expect.stringMatching(/^CC Switch：读取失败（.+）$/),
    ]);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('一个都没装：没有候选，也没有 warning', async () => {
    expect(await scan()).toEqual({ candidates: [], warnings: [] });
  });

  it('不能导入的候选（URL 不是 http(s)、键含空白）跳过并说明；过长的名称截断到 80 个字符', async () => {
    const longName = 'very-long-server-name-'.repeat(5);
    await writeFakeHome(home, {
      cursorMcp: JSON.stringify({
        mcpServers: {
          socket: { url: 'ws://localhost:9000/mcp' },
          spaced: { command: 'node', env: { 'BAD KEY': 'x' } },
          [longName]: { command: 'node', args: ['long.js'] },
        },
      }),
    });
    const { candidates, warnings } = await scan();
    expect(warnings).toEqual([
      'Cursor · socket：URL 必须是 http(s) 地址，已跳过',
      'Cursor · spaced：环境变量的键不能为空或含空白，已跳过',
    ]);
    expect(candidates.map(({ view }) => view.name)).toEqual([longName.slice(0, 80)]);
  });

  it('值里引用了变量（VS Code 的 input、环境变量、OpenCode 的 {env:…}）的提醒导入后改成实际值，不写出值本身', async () => {
    // `$` 单独拼进去：字面的「$ + 花括号」会被 Biome 当成写错的模板字符串
    const ref = (name: string) => `${'$'}{${name}}`;
    await writeFakeHome(home, {
      vscodeMcp: JSON.stringify({
        servers: {
          gh: {
            type: 'http',
            url: 'https://api.example.com/mcp',
            headers: { Authorization: `Bearer ${ref('input:gh-token')}` },
          },
        },
      }),
      opencodeJson: JSON.stringify({
        mcp: {
          tool: {
            type: 'local',
            command: ['tool', '--token', '{env:TOOL_TOKEN}'],
            environment: { HOME_DIR: ref('HOME'), PLAIN: 'value' },
          },
        },
      }),
    });
    const { candidates, warnings } = await scan();
    expect(candidates).toHaveLength(2);
    expect(warnings).toEqual([
      'VS Code · gh：Header Authorization 引用了变量，fynvra 不会展开，导入后请在编辑里改成实际值',
      'OpenCode · tool：环境变量 HOME_DIR、命令参数 引用了变量，fynvra 不会展开，导入后请在编辑里改成实际值',
    ]);
  });
});
