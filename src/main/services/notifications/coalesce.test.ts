import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer } from './coalesce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createCoalescer（同一 key 窗口内合并为最后一条）', () => {
  it('窗口从第一条开始计时，到点只发最后一条', () => {
    const emitted: string[] = [];
    const coalescer = createCoalescer<string>({
      windowMs: 2_000,
      emit: (item) => emitted.push(item),
    });

    coalescer.push('s1', 'a');
    vi.advanceTimersByTime(1_500);
    coalescer.push('s1', 'b');
    coalescer.push('s1', 'c');
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['c']);
    // 后来者不会把窗口往后推：连续不断的消息最多等一个窗口
    vi.advanceTimersByTime(10_000);
    expect(emitted).toEqual(['c']);
  });

  it('不同 key 各自计时', () => {
    const emitted: string[] = [];
    const coalescer = createCoalescer<string>({
      windowMs: 2_000,
      emit: (item) => emitted.push(item),
    });

    coalescer.push('s1', 'a');
    vi.advanceTimersByTime(1_000);
    coalescer.push('s2', 'b');
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['a']);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['a', 'b']);
  });

  it('发出之后再来的开新窗口', () => {
    const emitted: string[] = [];
    const coalescer = createCoalescer<string>({
      windowMs: 2_000,
      emit: (item) => emitted.push(item),
    });

    coalescer.push('s1', 'a');
    vi.advanceTimersByTime(2_000);
    coalescer.push('s1', 'b');
    vi.advanceTimersByTime(1_999);
    expect(emitted).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['a', 'b']);
  });

  it('clear 丢掉还没发出的', () => {
    const emit = vi.fn();
    const coalescer = createCoalescer<string>({ windowMs: 2_000, emit });

    coalescer.push('s1', 'a');
    coalescer.push('s2', 'b');
    coalescer.clear();
    vi.advanceTimersByTime(5_000);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
