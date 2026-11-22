import { describe, expect, it } from 'vitest';
import { tabsToClose } from './tabClose';

// 模拟拖动排序后的显示顺序：对话被拖到中间
const keys = ['file:a', 'chat', 'diff:b', 'terminal:c', 'file:d'];

describe('标签批量关闭', () => {
  it('关闭其他：排除自己和对话', () => {
    expect(tabsToClose(keys, 'diff:b', 'others')).toEqual(['file:a', 'terminal:c', 'file:d']);
  });
  it('关闭左侧 / 右侧按显示顺序计算且排除对话', () => {
    expect(tabsToClose(keys, 'terminal:c', 'left')).toEqual(['file:a', 'diff:b']);
    expect(tabsToClose(keys, 'file:a', 'right')).toEqual(['diff:b', 'terminal:c', 'file:d']);
    expect(tabsToClose(keys, 'file:d', 'right')).toEqual([]);
  });
  it('右键对话标签', () => {
    expect(tabsToClose(keys, 'chat', 'close')).toEqual([]);
    expect(tabsToClose(keys, 'chat', 'left')).toEqual(['file:a']);
    expect(tabsToClose(keys, 'chat', 'right')).toEqual(['diff:b', 'terminal:c', 'file:d']);
    expect(tabsToClose(keys, 'chat', 'others')).toEqual([
      'file:a',
      'diff:b',
      'terminal:c',
      'file:d',
    ]);
  });
  it('未知 key 不关闭任何标签', () => {
    expect(tabsToClose(keys, 'file:x', 'others')).toEqual([]);
  });
});
