import type { McpImportCandidate } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import {
  commandSummary,
  defaultSelection,
  duplicateBadge,
  duplicateReason,
  importSummary,
  invertSelection,
  MCP_IMPORT_SOURCES,
  orderedSelection,
  selectAll,
  toggleMcpSource,
} from './mcpImport';

const candidate = (id: string, extra: Partial<McpImportCandidate> = {}): McpImportCandidate => ({
  id,
  source: 'codex',
  sourceLabel: 'Codex',
  name: id,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', id],
  envKeys: [],
  headerKeys: [],
  enabledInSource: true,
  ...extra,
});

const list = [
  candidate('pencil', { source: 'claude-code', sourceLabel: 'Claude Code' }),
  candidate('dup', { duplicate: 'candidate', duplicateOf: 'Claude Code · pencil' }),
  candidate('figma', {
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    enabledInSource: false,
  }),
  candidate('old', { duplicate: 'existing', duplicateOf: 'GitHub' }),
  candidate('fetch', { source: 'cc-switch', sourceLabel: 'CC Switch' }),
];

describe('mcpImport', () => {
  it('默认勾选在来源里已启用且不重复的候选', () => {
    expect(defaultSelection(list)).toEqual(['pencil', 'fetch']);
  });

  it('全选 / 反选只作用于不重复的候选', () => {
    expect(selectAll(list)).toEqual(['pencil', 'figma', 'fetch']);
    expect(invertSelection(list, ['pencil', 'dup'])).toEqual(['figma', 'fetch']);
    expect(invertSelection(list, [])).toEqual(['pencil', 'figma', 'fetch']);
  });

  it('导入时按候选顺序提交，忽略已不在列表里的 id', () => {
    expect(orderedSelection(list, ['fetch', 'ghost', 'pencil'])).toEqual(['pencil', 'fetch']);
  });

  it('8 个来源开关，结果保持去重优先级的顺序', () => {
    expect(MCP_IMPORT_SOURCES.map((source) => source.id)).toEqual([
      'claude-code',
      'codex',
      'grok',
      'gemini',
      'cursor',
      'vscode',
      'opencode',
      'cc-switch',
    ]);
    expect(toggleMcpSource(['cc-switch'], 'claude-code', true)).toEqual([
      'claude-code',
      'cc-switch',
    ]);
    expect(toggleMcpSource(['claude-code', 'grok', 'cc-switch'], 'grok', false)).toEqual([
      'claude-code',
      'cc-switch',
    ]);
  });

  it('重复项说明与谁重复、比的是命令和参数还是 URL', () => {
    expect(duplicateReason(list[0] as McpImportCandidate)).toBeNull();
    expect(duplicateReason(list[1] as McpImportCandidate)).toBe(
      '与上面的「Claude Code · pencil」命令和参数相同'
    );
    expect(duplicateReason(list[3] as McpImportCandidate)).toBe(
      '已有命令和参数相同的服务器「GitHub」'
    );
    expect(
      duplicateReason(
        candidate('remote', {
          url: 'https://a.example.com',
          duplicate: 'existing',
          duplicateOf: 'A',
        })
      )
    ).toBe('已有 URL 相同的服务器「A」');
  });

  it('重复项在行里只是一个徽标：与已有服务器相同是「已有」，与上面的候选相同是「重复」', () => {
    expect(duplicateBadge(list[0] as McpImportCandidate)).toBeNull();
    expect(duplicateBadge(list[1] as McpImportCandidate)).toBe('重复');
    expect(duplicateBadge(list[3] as McpImportCandidate)).toBe('已有');
  });

  it('命令摘要：stdio 是命令加参数，远程是 URL', () => {
    expect(commandSummary(list[0] as McpImportCandidate)).toBe('npx -y pencil');
    expect(commandSummary(list[2] as McpImportCandidate)).toBe('https://mcp.figma.com/mcp');
    expect(commandSummary(candidate('bare', { args: undefined, command: 'uvx' }))).toBe('uvx');
  });

  it('导入结果的提示：导入数量，以及跳过了哪些、为什么', () => {
    expect(importSummary({ imported: [{ name: 'a' }, { name: 'b' }], skipped: [] })).toBe(
      '已导入 2 个 MCP 服务器'
    );
    expect(
      importSummary({
        imported: [{ name: 'a' }],
        skipped: [{ name: 'c', reason: '与「a」的命令和参数相同' }],
      })
    ).toBe('已导入 1 个 MCP 服务器；跳过 1 个：c（与「a」的命令和参数相同）');
  });
});
