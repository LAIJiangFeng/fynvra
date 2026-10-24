import { describe, expect, it } from 'vitest';
import { SECRETS, vscodeMcpJsonc } from '../fixtures';
import { readVsCode } from './vscode';

const STABLE = 'C:/Users/me/AppData/Roaming/Code/User/mcp.json';
const INSIDERS = 'C:/Users/me/AppData/Roaming/Code - Insiders/User/mcp.json';

describe('readVsCode', () => {
  it('JSONC（注释与尾逗号）：servers 下的 http 与 stdio，inputs 忽略', () => {
    expect(readVsCode([{ file: STABLE, text: vscodeMcpJsonc }])).toEqual({
      servers: [
        {
          source: 'vscode',
          sourceLabel: 'VS Code',
          name: 'github',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: SECRETS.copilot },
          enabledInSource: true,
        },
        {
          source: 'vscode',
          sourceLabel: 'VS Code',
          name: 'playwright',
          transport: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless'],
          enabledInSource: true,
        },
      ],
      warnings: [],
    });
  });

  it('Insiders 的文件标签是 VS Code Insiders；sse 类型照读', () => {
    const text =
      '{ "servers": { "events": { "type": "sse", "url": "https://e.example.com/sse" } } }';
    expect(readVsCode([{ file: INSIDERS, text }]).servers).toEqual([
      {
        source: 'vscode',
        sourceLabel: 'VS Code Insiders',
        name: 'events',
        transport: 'sse',
        url: 'https://e.example.com/sse',
        enabledInSource: true,
      },
    ]);
  });

  it('写坏的文件（本机的 mcp.json 就是 315 个 0 字节）记 warning 并跳过', () => {
    expect(readVsCode([{ file: STABLE, text: String.fromCharCode(0).repeat(315) }])).toEqual({
      servers: [],
      warnings: [`VS Code：${STABLE} 不是有效的 JSON，已跳过`],
    });
  });
});
