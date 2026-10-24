import { describe, expect, it } from 'vitest';
import { cursorMcpJson, SECRETS } from '../fixtures';
import { readCursor } from './cursor';

const MCP_JSON = 'C:/Users/me/.cursor/mcp.json';
const file = (text: string) => ({ file: MCP_JSON, text });

describe('readCursor', () => {
  it('同 Claude 格式：sse 与 stdio（自造的配置，本机是空的）', () => {
    expect(readCursor([file(cursorMcpJson)])).toEqual({
      servers: [
        {
          source: 'cursor',
          sourceLabel: 'Cursor',
          name: 'linear',
          transport: 'sse',
          url: 'https://mcp.linear.app/sse',
          enabledInSource: true,
        },
        {
          source: 'cursor',
          sourceLabel: 'Cursor',
          name: 'sqlite',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db-path', 'C:/data/app.db'],
          env: { SQLITE_TOKEN: SECRETS.sqlite },
          enabledInSource: true,
        },
      ],
      warnings: [],
    });
  });

  it('本机的 {}：没有候选也没有 warning；disabled: true 的标为未启用', () => {
    expect(readCursor([file('{}\n')])).toEqual({ servers: [], warnings: [] });
    const text = JSON.stringify({ mcpServers: { off: { command: 'node', disabled: true } } });
    expect(readCursor([file(text)]).servers[0]?.enabledInSource).toBe(false);
  });

  it('坏 JSON 记 warning（只有文件与行号）', () => {
    const result = readCursor([
      file('{\n  "mcpServers": {\n    "a": { "env": { "K": "sk-leak" } },\n  }\n'),
    ]);
    expect(result).toEqual({
      servers: [],
      warnings: [`Cursor：${MCP_JSON} 第 5 行不是有效的 JSON，已跳过`],
    });
  });
});
