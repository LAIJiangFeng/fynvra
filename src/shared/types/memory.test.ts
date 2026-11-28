import { describe, expect, it } from 'vitest';
import {
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  parseMemoryClearInput,
  parseMemoryCreateInput,
  parseMemoryListInput,
  parseMemoryRemoveInput,
  parseMemoryUpdateInput,
} from './memory';

const ws = 'ws_1';

describe('parseMemoryListInput / parseMemoryClearInput', () => {
  it.each([parseMemoryListInput, parseMemoryClearInput])('只接受合法 workspaceId', (parse) => {
    expect(parse({ workspaceId: ws })).toEqual({ workspaceId: ws });
    expect(parse({ workspaceId: ws, extra: 1 })).toBeNull();
    expect(parse({ workspaceId: 'C:\\repo' })).toBeNull();
    expect(parse({ workspaceId: 1 })).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse([ws])).toBeNull();
  });
});

describe('parseMemoryCreateInput', () => {
  it('合法入参：正文去首尾空白；每个类别都接受', () => {
    for (const category of MEMORY_CATEGORIES) {
      expect(
        parseMemoryCreateInput({ workspaceId: ws, category, content: '  先 pnpm install ' })
      ).toEqual({ workspaceId: ws, category, content: '先 pnpm install' });
    }
  });

  it('正文边界：1 与 500 字符可以，空白、501 字符、含 NUL 拒绝', () => {
    const base = { workspaceId: ws, category: 'rule' };
    expect(parseMemoryCreateInput({ ...base, content: 'a' })).not.toBeNull();
    expect(
      parseMemoryCreateInput({ ...base, content: 'a'.repeat(MEMORY_CONTENT_MAX) })
    ).not.toBeNull();
    expect(
      parseMemoryCreateInput({ ...base, content: 'a'.repeat(MEMORY_CONTENT_MAX + 1) })
    ).toBeNull();
    expect(parseMemoryCreateInput({ ...base, content: '   ' })).toBeNull();
    expect(parseMemoryCreateInput({ ...base, content: 'a\0b' })).toBeNull();
    expect(parseMemoryCreateInput({ ...base, content: 1 })).toBeNull();
  });

  it('拒绝非法类别、缺字段与多余键', () => {
    expect(parseMemoryCreateInput({ workspaceId: ws, category: 'note', content: 'x' })).toBeNull();
    expect(parseMemoryCreateInput({ workspaceId: ws, content: 'x' })).toBeNull();
    expect(
      parseMemoryCreateInput({ workspaceId: ws, category: 'rule', content: 'x', pinned: true })
    ).toBeNull();
  });
});

describe('parseMemoryUpdateInput', () => {
  it('接受任一可改字段的组合', () => {
    expect(parseMemoryUpdateInput({ workspaceId: ws, id: 3, content: ' x ' })).toEqual({
      workspaceId: ws,
      id: 3,
      content: 'x',
    });
    expect(
      parseMemoryUpdateInput({
        workspaceId: ws,
        id: 3,
        category: 'pitfall',
        pinned: false,
        status: 'disabled',
      })
    ).toEqual({ workspaceId: ws, id: 3, category: 'pitfall', pinned: false, status: 'disabled' });
    expect(parseMemoryUpdateInput({ workspaceId: ws, id: 3, status: 'active' })).not.toBeNull();
  });

  it.each([
    ['没有要改的字段', { workspaceId: ws, id: 3 }],
    ['status 为 expired', { workspaceId: ws, id: 3, status: 'expired' }],
    ['pinned 非布尔', { workspaceId: ws, id: 3, pinned: 1 }],
    ['类别非法', { workspaceId: ws, id: 3, category: 'x' }],
    ['正文为空', { workspaceId: ws, id: 3, content: '' }],
    ['id 为 0', { workspaceId: ws, id: 0, pinned: true }],
    ['id 为小数', { workspaceId: ws, id: 1.5, pinned: true }],
    ['id 超出安全整数', { workspaceId: ws, id: 2 ** 53, pinned: true }],
    ['id 为字符串', { workspaceId: ws, id: '3', pinned: true }],
    ['多余键', { workspaceId: ws, id: 3, pinned: true, extra: 1 }],
    ['workspaceId 非法', { workspaceId: '../x', id: 3, pinned: true }],
  ])('拒绝 %s', (_label, raw) => {
    expect(parseMemoryUpdateInput(raw)).toBeNull();
  });
});

describe('parseMemoryRemoveInput', () => {
  it('合法入参与各类非法入参', () => {
    expect(parseMemoryRemoveInput({ workspaceId: ws, id: Number.MAX_SAFE_INTEGER })).toEqual({
      workspaceId: ws,
      id: Number.MAX_SAFE_INTEGER,
    });
    expect(parseMemoryRemoveInput({ workspaceId: ws, id: -1 })).toBeNull();
    expect(parseMemoryRemoveInput({ workspaceId: ws })).toBeNull();
    expect(parseMemoryRemoveInput({ workspaceId: ws, id: 1, extra: 1 })).toBeNull();
    expect(parseMemoryRemoveInput('ws_1')).toBeNull();
  });
});
