import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpUpsertInput } from '../../../preload/domains/mcp';
import {
  createMcpRegistry,
  mcpDedupeKey,
  parseStoredMcpServer,
  type StoredMcpServer,
  toMcpServerView,
} from './mcpRegistry';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-mcp-'));
  filePath = join(dir, 'mcp.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const github: McpUpsertInput = {
  name: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  enabled: true,
  env: [{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }],
};

const readDisk = () => JSON.parse(readFileSync(filePath, 'utf8'));

describe('createMcpRegistry.upsert', () => {
  it('新建：id 由名称生成，env 明文写进 mcp.json', async () => {
    const registry = createMcpRegistry({ filePath });
    expect(await registry.upsert(github)).toEqual({
      ok: true,
      server: {
        id: 'github',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        enabled: true,
        env: { GITHUB_TOKEN: 'ghp_secret' },
      },
    });
    expect(readDisk().servers[0].env).toEqual({ GITHUB_TOKEN: 'ghp_secret' });
  });

  it('编辑：env 缺省全部沿用；不带 value 的键沿用旧值；没列出的键删除', async () => {
    const registry = createMcpRegistry({ filePath });
    await registry.upsert({
      ...github,
      env: [
        { key: 'GITHUB_TOKEN', value: 'ghp_secret' },
        { key: 'DEBUG', value: '1' },
      ],
    });
    const { env: _omit, ...withoutEnv } = github;

    await registry.upsert({ ...withoutEnv, id: 'github', name: 'GitHub MCP' });
    expect((await registry.get('github'))?.env).toEqual({ GITHUB_TOKEN: 'ghp_secret', DEBUG: '1' });

    await registry.upsert({
      ...withoutEnv,
      id: 'github',
      env: [{ key: 'GITHUB_TOKEN' }, { key: 'LOG', value: '' }],
    });
    expect((await registry.get('github'))?.env).toEqual({ GITHUB_TOKEN: 'ghp_secret', LOG: '' });
  });

  it('新键没有 value 时报错；编辑不存在的 id 报错', async () => {
    const registry = createMcpRegistry({ filePath });
    expect(await registry.upsert({ ...github, env: [{ key: 'TOKEN' }] })).toMatchObject({
      ok: false,
    });
    expect(await registry.upsert({ ...github, id: 'ghost' })).toMatchObject({ ok: false });
    expect(await registry.list()).toEqual([]);
  });

  it('切换传输方式时丢掉另一种方式的字段与密钥', async () => {
    const registry = createMcpRegistry({ filePath });
    await registry.upsert(github);
    const result = await registry.upsert({
      id: 'github',
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      enabled: true,
      headers: [{ key: 'Authorization', value: 'Bearer ghp_secret' }],
    });
    expect(result).toEqual({
      ok: true,
      server: {
        id: 'github',
        name: 'GitHub',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        headers: { Authorization: 'Bearer ghp_secret' },
      },
    });
  });
});

describe('createMcpRegistry.addMany / setEnabled / remove', () => {
  it('导入按命令+参数 / URL 去重（含已登记的与批内的），同名 id 加后缀', async () => {
    const registry = createMcpRegistry({ filePath });
    await registry.upsert(github);
    const result = await registry.addMany([
      {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
      { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'other-github'] },
      { name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp/' },
      { name: 'docs-again', transport: 'sse', url: 'https://mcp.example.com/mcp' },
    ]);
    expect(result.skipped).toBe(2);
    expect(result.added.map((server) => server.id)).toEqual(['github-2', 'docs']);
    expect(result.added.every((server) => server.enabled)).toBe(true);
  });

  it('setEnabled / remove 按 id 操作', async () => {
    const registry = createMcpRegistry({ filePath });
    await registry.upsert(github);
    expect(await registry.setEnabled('github', false)).toMatchObject({ enabled: false });
    expect(await registry.setEnabled('ghost', false)).toBeUndefined();
    expect(await registry.remove('github')).toBe(true);
    expect(await registry.remove('github')).toBe(false);
  });
});

describe('视图与去重键', () => {
  const stored: StoredMcpServer = {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server-github'],
    enabled: true,
    env: { GITHUB_TOKEN: 'ghp_secret' },
    headers: {},
  };

  it('toMcpServerView 只给 env / headers 的键名', () => {
    const view = toMcpServerView(stored);
    expect(view).toEqual({
      id: 'github',
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      enabled: true,
      envKeys: ['GITHUB_TOKEN'],
      headerKeys: [],
    });
    expect(JSON.stringify(view)).not.toContain('ghp_secret');
  });

  it('mcpDedupeKey：URL 忽略末尾斜杠；命令与参数逐项比较', () => {
    expect(mcpDedupeKey({ url: 'https://a.example.com/mcp/' })).toBe(
      mcpDedupeKey({ url: 'https://a.example.com/mcp' })
    );
    expect(mcpDedupeKey({ command: 'npx', args: ['a b'] })).not.toBe(
      mcpDedupeKey({ command: 'npx', args: ['a', 'b'] })
    );
  });

  it('parseStoredMcpServer 宽松收窄磁盘记录', () => {
    expect(
      parseStoredMcpServer({
        id: 'time',
        name: 'time',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-time', 1],
        env: { TZ: 'Asia/Shanghai', BAD: 2 },
        junk: true,
      })
    ).toEqual({
      id: 'time',
      name: 'time',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      enabled: true,
      env: { TZ: 'Asia/Shanghai' },
    });
    expect(parseStoredMcpServer({ id: 'x', name: 'x', transport: 'stdio' })).toBeNull();
    expect(
      parseStoredMcpServer({ id: 'x', name: 'x', transport: 'http', command: 'a' })
    ).toBeNull();
  });
});
