import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importClaudeMcp, parseMcpServerMap, readClaudeMcpServers } from './claudeImport';

describe('parseMcpServerMap', () => {
  it('按 type 与字段归一化传输方式，env / headers 只留字符串值', () => {
    expect(
      parseMcpServerMap({
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github', 42],
          env: { GITHUB_TOKEN: 'ghp_secret', DEBUG: 1 },
        },
        docs: {
          type: 'sse',
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer x' },
        },
        stream: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
        implicitHttp: { url: 'https://mcp.example.com/other' },
        implicitStdio: { command: 'uvx', args: ['mcp-server-time'] },
      })
    ).toEqual([
      {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret' },
      },
      {
        name: 'docs',
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: { Authorization: 'Bearer x' },
      },
      { name: 'stream', transport: 'http', url: 'https://mcp.example.com/mcp' },
      { name: 'implicitHttp', transport: 'http', url: 'https://mcp.example.com/other' },
      { name: 'implicitStdio', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
    ]);
  });

  it('既没有 command 也没有 url 的条目、非对象条目跳过；非对象输入返回空', () => {
    expect(parseMcpServerMap({ broken: { type: 'stdio' }, junk: 'x', nil: null })).toEqual([]);
    expect(parseMcpServerMap(undefined)).toEqual([]);
    expect(parseMcpServerMap(['x'])).toEqual([]);
  });
});

describe('Claude 配置文件', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fynvra-claude-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('readClaudeMcpServers 合并顶层与各项目下的 mcpServers', async () => {
    const file = join(home, '.claude.json');
    writeFileSync(
      file,
      JSON.stringify({
        numStartups: 3,
        mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } },
        projects: {
          'C:/work/a': { mcpServers: { db: { command: 'node', args: ['db.js'] } } },
          'C:/work/b': { allowedTools: [] },
        },
      })
    );
    expect((await readClaudeMcpServers(file)).map((server) => server.name)).toEqual(['time', 'db']);
  });

  it('importClaudeMcp：两个文件各自报告状态，坏文件不影响另一个', async () => {
    writeFileSync(join(home, '.claude.json'), '{ broken');
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { web: { type: 'http', url: 'https://mcp.example.com/mcp' } } })
    );
    const result = await importClaudeMcp({ home });
    expect(result.servers.map((server) => server.name)).toEqual(['web']);
    expect(result.sources.map(({ status, count }) => ({ status, count }))).toEqual([
      { status: 'error', count: 0 },
      { status: 'found', count: 1 },
    ]);
    expect(result.sources[0]?.file).toBe(join(home, '.claude.json'));
    expect(result.sources[0]?.error).toBeTruthy();
  });

  it('文件不存在时是 not-found', async () => {
    const result = await importClaudeMcp({ home });
    expect(result.servers).toEqual([]);
    expect(result.sources.map((source) => source.status)).toEqual(['not-found', 'not-found']);
  });
});
