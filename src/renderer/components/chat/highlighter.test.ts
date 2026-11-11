import { describe, expect, it } from 'vitest';
import { CharLru } from './highlighter';

describe('CharLru', () => {
  it('按 key 总字符数淘汰最久没用的，命中会刷新', () => {
    const lru = new CharLru<number>(6);
    lru.set('aa', 1);
    lru.set('bb', 2);
    lru.set('cc', 3);
    expect(lru.get('aa')).toBe(1); // aa 变成最新
    lru.set('dd', 4); // 超额 → 淘汰 bb
    expect(lru.get('bb')).toBeUndefined();
    expect([lru.get('aa'), lru.get('cc'), lru.get('dd')]).toEqual([1, 3, 4]);
  });

  it('重复 set 不重复计数，超过上限的单项不缓存', () => {
    const lru = new CharLru<number>(4);
    lru.set('ab', 1);
    lru.set('ab', 2);
    lru.set('cd', 3);
    expect([lru.get('ab'), lru.get('cd')]).toEqual([2, 3]);
    lru.set('toolong', 4);
    expect(lru.get('toolong')).toBeUndefined();
    expect(lru.get('ab')).toBe(2);
  });
});
