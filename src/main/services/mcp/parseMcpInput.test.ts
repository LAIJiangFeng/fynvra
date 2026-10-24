import { describe, expect, it } from 'vitest';
import { parseMcpUpsert } from './parseMcpInput';

const stdio = {
  name: '  GitHub ',
  transport: 'stdio',
  command: ' npx ',
  args: ['-y', ' keep spaces '],
  enabled: true,
  env: [{ key: ' GITHUB_TOKEN ', value: ' ghp secret ' }, { key: 'KEEP' }],
};

const http = {
  id: 'docs',
  name: 'Docs',
  transport: 'http',
  url: ' https://mcp.example.com/mcp ',
  enabled: false,
  headers: [{ key: 'Authorization', value: 'Bearer x' }],
};

describe('parseMcpUpsert', () => {
  it('stdio：名称 / 命令 / 键名去空白，参数与值保持原样', () => {
    expect(parseMcpUpsert(stdio)).toEqual({
      ok: true,
      input: {
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', ' keep spaces '],
        enabled: true,
        env: [{ key: 'GITHUB_TOKEN', value: ' ghp secret ' }, { key: 'KEEP' }],
      },
    });
  });

  it('http / sse：URL 必填且是 http(s)', () => {
    expect(parseMcpUpsert(http)).toEqual({
      ok: true,
      input: {
        id: 'docs',
        name: 'Docs',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
        headers: [{ key: 'Authorization', value: 'Bearer x' }],
      },
    });
    expect(parseMcpUpsert({ ...http, transport: 'sse' })).toMatchObject({ ok: true });
  });

  it.each([
    ['非对象', 'github'],
    ['未知字段', { ...stdio, cwd: '/tmp' }],
    ['非法 id', { ...stdio, id: 'A/B' }],
    ['空名称', { ...stdio, name: ' ' }],
    ['未知传输', { ...stdio, transport: 'websocket' }],
    ['enabled 缺失', { ...stdio, enabled: undefined }],
    ['stdio 缺命令', { ...stdio, command: '  ' }],
    ['stdio 带 URL', { ...stdio, url: 'https://x.example.com' }],
    ['stdio 带 headers', { ...stdio, headers: [] }],
    ['参数不是字符串', { ...stdio, args: ['-y', 1] }],
    ['http 缺 URL', { ...http, url: undefined }],
    ['http 非 http 地址', { ...http, url: 'ws://x.example.com' }],
    ['http 带命令', { ...http, command: 'npx' }],
    ['http 带 env', { ...http, env: [] }],
    ['env 不是数组', { ...stdio, env: { A: '1' } }],
    ['env 项未知字段', { ...stdio, env: [{ key: 'A', value: '1', secret: true }] }],
    [
      'env 键重复',
      {
        ...stdio,
        env: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      },
    ],
    ['env 键含空白', { ...stdio, env: [{ key: 'A B', value: '1' }] }],
    ['env 值不是字符串', { ...stdio, env: [{ key: 'A', value: 1 }] }],
  ])('拒绝 %s', (_label, raw) => {
    const result = parseMcpUpsert(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
  });
});
