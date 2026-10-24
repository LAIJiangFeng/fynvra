import { describe, expect, it } from 'vitest';
import { geminiSettingsJson, PENCIL_EXE, SECRETS } from '../fixtures';
import { readGemini } from './gemini';

const SETTINGS = 'C:/Users/me/.gemini/settings.json';
const file = (text: string) => ({ file: SETTINGS, text });
const meta = { source: 'gemini', sourceLabel: 'Gemini CLI' } as const;

describe('readGemini', () => {
  it('本机格式：command / httpUrl（Streamable HTTP）/ url（SSE）；timeout 忽略；mcp.excluded 里的标为未启用', () => {
    expect(readGemini([file(geminiSettingsJson)])).toEqual({
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
          name: 'remote-docs',
          transport: 'http',
          url: 'https://gemini-docs.example.com/mcp',
          headers: { Authorization: SECRETS.geminiBearer },
          enabledInSource: true,
        },
        {
          ...meta,
          name: 'legacy-sse',
          transport: 'sse',
          url: 'https://sse.example.com/sse',
          enabledInSource: false,
        },
      ],
      warnings: [],
    });
  });

  it('设了 mcp.allowed 时只有列在里面的算启用；旧版的 allowMCPServers / excludeMCPServers 也认', () => {
    const servers = {
      a: { command: 'a' },
      b: { command: 'b' },
      c: { command: 'c' },
    };
    const enabled = (settings: Record<string, unknown>) =>
      readGemini([file(JSON.stringify({ mcpServers: servers, ...settings }))]).servers.map(
        (server) => [server.name, server.enabledInSource]
      );
    expect(enabled({ mcp: { allowed: ['a', 'b'], excluded: ['b'] } })).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
    expect(enabled({ allowMCPServers: ['c'] })).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
    expect(enabled({ excludeMCPServers: ['a'] })).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ]);
  });

  it('url 带 type: "http" 时按 Streamable HTTP；httpUrl 优先于 url', () => {
    const text = JSON.stringify({
      mcpServers: {
        typed: { url: 'https://a.example.com/mcp', type: 'http' },
        both: { httpUrl: 'https://b.example.com/mcp', url: 'https://b.example.com/sse' },
      },
    });
    expect(
      readGemini([file(text)]).servers.map(({ name, transport, url }) => [name, transport, url])
    ).toEqual([
      ['typed', 'http', 'https://a.example.com/mcp'],
      ['both', 'http', 'https://b.example.com/mcp'],
    ]);
  });

  it('坏 JSON 记 warning；没有 mcpServers 时没有候选', () => {
    expect(readGemini([file('{ "mcpServers": { ')])).toEqual({
      servers: [],
      warnings: [`Gemini CLI：${SETTINGS} 第 1 行不是有效的 JSON，已跳过`],
    });
    expect(readGemini([file('{ "general": {} }')])).toEqual({ servers: [], warnings: [] });
  });
});
