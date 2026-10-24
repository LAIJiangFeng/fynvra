import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './ids';

afterEach(() => {
  vi.useRealTimers();
});

describe('newId', () => {
  it('以 `<prefix>_` 开头，只含小写字母、数字和下划线', () => {
    const id = newId('task');
    expect(id).toMatch(/^task_[a-z0-9]+$/);
    expect(id.length).toBeGreaterThan('task_'.length + 12);
  });

  it('大量生成不重复', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('msg')));
    expect(ids.size).toBe(10_000);
  });

  it('不同毫秒生成的 id 按字典序递增', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    const earlier = newId('run');
    vi.setSystemTime(new Date('2026-10-24T00:00:01Z'));
    const later = newId('run');
    expect(earlier < later).toBe(true);
  });

  it('拒绝不是小写 slug 的前缀', () => {
    for (const prefix of ['', 'Task', 'has space', 'a_b', '../x', '1st']) {
      expect(() => newId(prefix)).toThrow(TypeError);
    }
  });
});
