import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importClaudeMcp } from './claudeImport';

// 解析规则（type 归一化、缺字段跳过、项目级服务器）在 import/readers/claudeCode.test.ts。

describe('importClaudeMcp（mcp:import-claude）', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fynvra-claude-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('合并 ~/.claude.json 顶层与各项目下的 mcpServers', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        numStartups: 3,
        mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } },
        projects: {
          'C:/work/a': { mcpServers: { db: { command: 'node', args: ['db.js'] } } },
          'C:/work/b': { allowedTools: [] },
        },
      })
    );
    const result = await importClaudeMcp({ home });
    expect(result.servers.map((server) => server.name)).toEqual(['time', 'db']);
    expect(result.sources.map(({ status, count }) => ({ status, count }))).toEqual([
      { status: 'found', count: 2 },
      { status: 'not-found', count: 0 },
    ]);
  });

  it('两个文件各自报告状态，坏文件不影响另一个；错误信息不带文件内容', async () => {
    writeFileSync(join(home, '.claude.json'), '{ "token": "sk-should-not-leak" broken');
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
    expect(result.sources[0]).toMatchObject({
      file: join(home, '.claude.json'),
      error: '不是合法的 JSON',
    });
    expect(JSON.stringify(result)).not.toContain('sk-should-not-leak');
  });

  it('文件不存在时是 not-found；读不了（是目录）时是 error', async () => {
    expect(await importClaudeMcp({ home })).toMatchObject({
      servers: [],
      sources: [{ status: 'not-found' }, { status: 'not-found' }],
    });
    mkdirSync(join(home, '.claude.json'));
    const result = await importClaudeMcp({ home });
    expect(result.sources[0]?.status).toBe('error');
    expect(result.sources[0]?.error).toBeTruthy();
  });
});
