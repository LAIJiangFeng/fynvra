import { describe, expect, it } from 'vitest';
import { opencodeJson, PENCIL_EXE, SECRETS } from '../fixtures';
import { readOpenCode } from './opencode';

const CONFIG = 'C:/Users/me/.config/opencode/opencode.json';
const file = (text: string, path = CONFIG) => ({ file: path, text });
const meta = { source: 'opencode', sourceLabel: 'OpenCode' } as const;

describe('readOpenCode', () => {
  it('local 的 command 数组：第一个是命令、其余是参数；environment → env；remote 的 url 与 headers；enabled: false', () => {
    expect(readOpenCode([file(opencodeJson)])).toEqual({
      servers: [
        {
          ...meta,
          name: 'pencil',
          transport: 'stdio',
          command: PENCIL_EXE,
          args: ['--app', 'visual_studio_code'],
          enabledInSource: true,
        },
        {
          ...meta,
          name: 'context7',
          transport: 'http',
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: SECRETS.context7 },
          enabledInSource: false,
        },
        {
          ...meta,
          name: 'everything',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
          env: { LOG_LEVEL: 'debug' },
          enabledInSource: true,
        },
      ],
      warnings: [],
    });
  });

  it('没写 type 时按字段判断；command 是字符串也接受；command 为空的跳过并说明', () => {
    const text = JSON.stringify({
      mcp: {
        guessed: { url: 'https://g.example.com/mcp' },
        single: { command: 'my-server' },
        empty: { type: 'local', command: [] },
      },
    });
    const { servers, warnings } = readOpenCode([file(text)]);
    expect(
      servers.map(({ name, transport, command, url }) => ({ name, transport, command, url }))
    ).toEqual([
      { name: 'guessed', transport: 'http', command: undefined, url: 'https://g.example.com/mcp' },
      { name: 'single', transport: 'stdio', command: 'my-server', url: undefined },
    ]);
    expect(warnings).toEqual(['OpenCode · empty：没有命令或 URL，已跳过']);
  });

  it('opencode.jsonc 带注释与尾逗号也能读；坏文件记 warning', () => {
    const jsonc = '{\n  // 本地\n  "mcp": { "a": { "type": "local", "command": ["a"], }, },\n}\n';
    expect(readOpenCode([file(jsonc, `${CONFIG}c`)]).servers.map((s) => s.name)).toEqual(['a']);
    expect(readOpenCode([file('{ "mcp": ')]).warnings).toEqual([
      `OpenCode：${CONFIG} 不是有效的 JSON，已跳过`,
    ]);
  });
});
