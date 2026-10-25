import { describe, expect, it } from 'vitest';
import { cycleSessionId, filterSessionsByTitle } from './sessionFilter';

const sessions = [
  { id: 's1', title: '重构 Composer' },
  { id: 's2', title: 'Fix settings page' },
  { id: 's3', title: 'composer 快捷键' },
];

describe('filterSessionsByTitle', () => {
  it('按标题包含过滤，不分大小写，去掉首尾空白', () => {
    expect(filterSessionsByTitle(sessions, 'composer').map(({ id }) => id)).toEqual(['s1', 's3']);
    expect(filterSessionsByTitle(sessions, '  SETTINGS ').map(({ id }) => id)).toEqual(['s2']);
    expect(filterSessionsByTitle(sessions, '快捷键').map(({ id }) => id)).toEqual(['s3']);
    expect(filterSessionsByTitle(sessions, 'nothing')).toEqual([]);
  });

  it('空查询返回原数组（同一引用，不触发重渲染）', () => {
    expect(filterSessionsByTitle(sessions, '')).toBe(sessions);
    expect(filterSessionsByTitle(sessions, '   ')).toBe(sessions);
  });
});

describe('cycleSessionId', () => {
  const ids = ['s1', 's2', 's3'];

  it('往后 / 往前走一个，首尾相接', () => {
    expect(cycleSessionId(ids, 's1', 1)).toBe('s2');
    expect(cycleSessionId(ids, 's3', 1)).toBe('s1');
    expect(cycleSessionId(ids, 's2', -1)).toBe('s1');
    expect(cycleSessionId(ids, 's1', -1)).toBe('s3');
  });

  it('没选中或选中的不在列表里（被过滤掉）：往后取第一个，往前取最后一个', () => {
    expect(cycleSessionId(ids, null, 1)).toBe('s1');
    expect(cycleSessionId(ids, null, -1)).toBe('s3');
    expect(cycleSessionId(ids, 'other', 1)).toBe('s1');
    expect(cycleSessionId(ids, 'other', -1)).toBe('s3');
  });

  it('列表为空时为 null；只有一个时停在它', () => {
    expect(cycleSessionId([], 's1', 1)).toBeNull();
    expect(cycleSessionId(['s1'], 's1', 1)).toBe('s1');
  });
});
