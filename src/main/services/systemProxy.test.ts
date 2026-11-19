import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemProxyResolver, SYSTEM_PROXY_PROBE_URL } from './systemProxy';

afterEach(() => vi.useRealTimers());

describe('createSystemProxyResolver', () => {
  it('缓存可用：5 秒内不重复解析，超过才刷新', async () => {
    let time = 0;
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:7890');
    const resolver = createSystemProxyResolver({ resolve, now: () => time });
    expect(resolver.current()).toEqual({ kind: 'unknown' });
    expect(await resolver.fresh()).toEqual({ kind: 'proxy', url: 'http://127.0.0.1:7890' });
    expect(resolve).toHaveBeenCalledWith(SYSTEM_PROXY_PROBE_URL);
    time = 5_000;
    await resolver.fresh();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolver.current()).toEqual({ kind: 'proxy', url: 'http://127.0.0.1:7890' });
    resolve.mockResolvedValueOnce('DIRECT');
    time = 5_001;
    expect(await resolver.fresh()).toEqual({ kind: 'direct' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('刷新失败保留上一次结果，连续失败只记一次日志', async () => {
    let time = 0;
    const log = vi.fn();
    const resolve = vi.fn(async () => 'PROXY h:1');
    const resolver = createSystemProxyResolver({ resolve, now: () => time, log });
    await resolver.fresh();
    resolve.mockRejectedValue(new Error('boom'));
    for (const step of [10_000, 20_000]) {
      time = step;
      expect(await resolver.fresh()).toEqual({ kind: 'proxy', url: 'http://h:1' });
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).not.toContain('boom');
  });

  it('启动等待有 3 秒上限，之后每 10 秒后台刷新', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(() => new Promise<string>(() => {}));
    const resolver = createSystemProxyResolver({ resolve });
    let started = false;
    void resolver.start().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    expect(resolver.current()).toEqual({ kind: 'unknown' });
    // 上一次解析还没回来时不重复发起
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    resolver.stop();
  });

  it('后台定时刷新拿到新结果', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => 'DIRECT');
    const resolver = createSystemProxyResolver({ resolve });
    await resolver.start();
    expect(resolver.current()).toEqual({ kind: 'direct' });
    resolve.mockResolvedValue('PROXY h:2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolver.current()).toEqual({ kind: 'proxy', url: 'http://h:2' });
    resolver.stop();
  });
});
