import { describe, expect, it } from 'vitest';
import { buildIndexText } from './indexText';
import { jaccard, rankDocs, tokenize } from './search';
import type { MemoryRow } from './store';

describe('tokenize', () => {
  it('英文数字按单词转小写，中日韩按二元组，单字取单字', () => {
    expect(tokenize('Run pnpm Test-2 now')).toEqual(['run', 'pnpm', 'test', '2', 'now']);
    expect(tokenize('先跑测试')).toEqual(['先跑', '跑测', '测试']);
    expect(tokenize('用 pnpm 跑')).toEqual(['用', 'pnpm', '跑']);
    expect(tokenize('ＡＢＣ')).toEqual(['abc']);
  });
});

describe('jaccard', () => {
  it('token 集合相似度', () => {
    expect(jaccard('run pnpm test', 'run pnpm test')).toBe(1);
    expect(jaccard('a b', 'c d')).toBe(0);
    expect(jaccard('提交前跑测试', '提交前先跑测试')).toBeGreaterThanOrEqual(0.5);
    expect(jaccard('', '')).toBe(0);
  });
});

describe('rankDocs', () => {
  const docs = [
    { id: 1, content: '提交前必须跑 pnpm test', category: 'rule', files: [] },
    {
      id: 2,
      content: 'The build output lives in dist',
      category: 'architecture',
      files: ['vite.config.ts'],
    },
    { id: 3, content: '数据库迁移脚本在 migrations 目录', category: 'architecture', files: [] },
  ];

  it('中英文关键词都能命中，按得分排序，没命中不返回', () => {
    expect(rankDocs(docs, '测试').map((hit) => hit.id)).toEqual([]);
    expect(rankDocs(docs, '跑 pnpm').map((hit) => hit.id)).toEqual([1]);
    expect(rankDocs(docs, '迁移脚本').map((hit) => hit.id)).toEqual([3]);
    expect(rankDocs(docs, 'BUILD dist').map((hit) => hit.id)).toEqual([2]);
    expect(rankDocs(docs, 'vite').map((hit) => hit.id)).toEqual([2]);
    expect(
      rankDocs(docs, 'architecture')
        .map((hit) => hit.id)
        .sort()
    ).toEqual([2, 3]);
    expect(rankDocs(docs, '   ')).toEqual([]);
  });
});

function row(id: number, extra: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    project_key: 'k',
    category: 'rule',
    content: `entry ${id}`,
    content_hash: `h${id}`,
    status: 'active',
    pinned: 0,
    source_kind: 'agent',
    source_session_id: null,
    source_task_id: null,
    source_workspace_id: null,
    source_title: null,
    evidence: null,
    files: '[]',
    created_at: 0,
    updated_at: id,
    last_used_at: null,
    use_count: 0,
    flagged_at: null,
    flag_note: null,
    flagged_by_session: null,
    disabled_reason: null,
    status_changed_at: null,
    promoted_at: null,
    ...extra,
  };
}

describe('buildIndexText', () => {
  it('只列 active；pinned → 类别 → 最近时间倒序；换行变空格，过时加后缀', () => {
    const text = buildIndexText([
      row(1, { category: 'pitfall', updated_at: 10 }),
      row(2, { category: 'rule', updated_at: 5 }),
      row(3, { category: 'rule', updated_at: 1, last_used_at: 50 }),
      row(4, { category: 'reference', pinned: 1, content: 'line1\nline2' }),
      row(5, { status: 'disabled' }),
      row(6, { category: 'pitfall', flagged_at: 7, updated_at: 1 }),
    ]);
    expect(text.split('\n')).toEqual([
      '- #4 [reference] line1 line2',
      '- #3 [rule] entry 3',
      '- #2 [rule] entry 2',
      '- #1 [pitfall] entry 1',
      '- #6 [pitfall] entry 6 (reported outdated)',
    ]);
  });

  it('内容截到 150 字；超过 60 条或 6000 字时截断并提示剩余条数', () => {
    const long = buildIndexText([row(1, { content: '长'.repeat(300) })]);
    expect(long).toBe(`- #1 [rule] ${'长'.repeat(150)}`);

    const many = buildIndexText(Array.from({ length: 70 }, (_, i) => row(i + 1)));
    const lines = many.split('\n');
    expect(lines).toHaveLength(61);
    expect(lines.at(-1)).toBe('另有 10 条，用 project_memory_search');

    const big = buildIndexText(
      Array.from({ length: 50 }, (_, i) => row(i + 1, { content: 'x'.repeat(150) }))
    );
    const bigLines = big.split('\n');
    const kept = bigLines.slice(0, -1);
    expect(kept.join('').length).toBeLessThanOrEqual(6000);
    expect(bigLines.at(-1)).toBe(`另有 ${50 - kept.length} 条，用 project_memory_search`);
  });
});
