import type { ProviderImportCandidate } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import {
  defaultSelection,
  duplicateBadge,
  duplicateReason,
  importSummary,
  invertSelection,
  modelSummary,
  orderedSelection,
  selectAll,
  toggleSource,
} from './providerImport';

const candidate = (
  id: string,
  extra: Partial<ProviderImportCandidate> = {}
): ProviderImportCandidate => ({
  id,
  source: 'cc-switch',
  sourceLabel: `CC Switch · ${id}`,
  name: id,
  api: 'anthropic-messages',
  models: [],
  hasApiKey: true,
  apiKeyHint: '1234',
  isCurrent: false,
  ...extra,
});

const list = [
  candidate('claude', { source: 'claude-code', sourceLabel: 'Claude Code', isCurrent: true }),
  candidate('dup', { isCurrent: true, duplicate: 'candidate', duplicateOf: 'Claude Code' }),
  candidate('cursor'),
  candidate('old', { duplicate: 'existing', duplicateOf: '公司中转' }),
  candidate('gemini', { api: 'google-generative-ai', isCurrent: true }),
];

describe('providerImport', () => {
  it('默认勾选正在使用且不重复的候选', () => {
    expect(defaultSelection(list)).toEqual(['claude', 'gemini']);
  });

  it('全选 / 反选只作用于不重复的候选', () => {
    expect(selectAll(list)).toEqual(['claude', 'cursor', 'gemini']);
    expect(invertSelection(list, ['claude', 'dup'])).toEqual(['cursor', 'gemini']);
    expect(invertSelection(list, [])).toEqual(['claude', 'cursor', 'gemini']);
  });

  it('导入时按候选顺序提交，忽略已不在列表里的 id', () => {
    expect(orderedSelection(list, ['gemini', 'ghost', 'claude'])).toEqual(['claude', 'gemini']);
  });

  it('来源开关保持 Claude Code、Codex、CC Switch 的顺序', () => {
    expect(toggleSource(['cc-switch'], 'claude-code', true)).toEqual(['claude-code', 'cc-switch']);
    expect(toggleSource(['claude-code', 'codex', 'cc-switch'], 'codex', false)).toEqual([
      'claude-code',
      'cc-switch',
    ]);
  });

  it('重复项说明与谁重复', () => {
    expect(duplicateReason(list[0] as ProviderImportCandidate)).toBeNull();
    expect(duplicateReason(list[1] as ProviderImportCandidate)).toBe(
      '与上面的「Claude Code」地址和 API Key 都相同'
    );
    expect(duplicateReason(list[3] as ProviderImportCandidate)).toBe(
      '已有地址和 API Key 都相同的服务「公司中转」'
    );
  });

  it('重复项在行里只是一个徽标：与已有服务相同是「已有」，与上面的候选相同是「重复」', () => {
    expect(duplicateBadge(list[0] as ProviderImportCandidate)).toBeNull();
    expect(duplicateBadge(list[1] as ProviderImportCandidate)).toBe('重复');
    expect(duplicateBadge(list[3] as ProviderImportCandidate)).toBe('已有');
  });

  it('模型摘要：列出前 3 个；没有模型时注明会不会用预置模型，不写导入后怎么做', () => {
    const models = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() }));
    expect(modelSummary(candidate('x', { models }))).toBe('模型：A、B、C 等 5 个');
    expect(modelSummary(candidate('x', { models: models.slice(0, 1) }))).toBe('模型：A');
    expect(modelSummary(candidate('x'))).toBe('未写模型（用预置模型）');
    expect(modelSummary(candidate('x', { api: 'openai-completions' }))).toBe('未写模型');
  });

  it('导入结果的提示：导入数量，以及跳过了哪些、为什么', () => {
    expect(importSummary({ imported: [{ name: 'A' }, { name: 'B' }], skipped: [] })).toBe(
      '已导入 2 个模型服务'
    );
    expect(
      importSummary({
        imported: [{ name: 'A' }],
        skipped: [{ name: 'C', reason: '与「A」的地址和 API Key 都相同' }],
      })
    ).toBe('已导入 1 个模型服务；跳过 1 个：C（与「A」的地址和 API Key 都相同）');
  });
});
