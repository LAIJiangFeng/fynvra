import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferAction, registerActionHandler, runAction } from './handlers';

const cleanups: (() => void)[] = [];
function register(...args: Parameters<typeof registerActionHandler>) {
  const unregister = registerActionHandler(...args);
  cleanups.push(unregister);
  return unregister;
}
function defer(...args: Parameters<typeof deferAction>) {
  const cancel = deferAction(...args);
  cleanups.push(cancel);
  return cancel;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('动作处理函数的登记', () => {
  it('没有组件处理时 runAction 返回 false（不拦截按键）', () => {
    expect(runAction('new-session')).toBe(false);
  });

  it('登记后执行它；注销后不再执行', () => {
    const handler = vi.fn();
    const unregister = register('focus-composer', handler);
    expect(runAction('focus-composer')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    unregister();
    expect(runAction('focus-composer')).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('同一动作登记了多个时最后登记的生效；它注销后回到前一个', () => {
    const first = vi.fn();
    const second = vi.fn();
    register('search-sessions', first);
    const unregisterSecond = register('search-sessions', second);

    runAction('search-sessions');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    runAction('search-sessions');
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('各动作互不影响；重复注销无副作用', () => {
    const settings = vi.fn();
    const unregister = register('open-settings', settings);
    register('open-settings', vi.fn());
    unregister();
    unregister();
    expect(runAction('toggle-side-panel')).toBe(false);
    expect(runAction('open-settings')).toBe(true);
    expect(settings).not.toHaveBeenCalled();
  });
});

describe('等处理它的组件挂载后再执行（deferAction）', () => {
  it('下一个登记的处理函数一登记就执行一次；之后照常按键才执行', () => {
    defer('new-session');
    expect(runAction('new-session')).toBe(false);

    const handler = vi.fn();
    register('new-session', handler);
    expect(handler).toHaveBeenCalledTimes(1);

    // 只执行一次：组件重新挂载不会再自动执行
    const remounted = vi.fn();
    register('new-session', remounted);
    expect(remounted).not.toHaveBeenCalled();
    expect(runAction('new-session')).toBe(true);
    expect(remounted).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('已经登记着的处理函数（如兜底）不算，等下一个登记的', () => {
    const fallback = vi.fn();
    register('search-sessions', fallback);
    defer('search-sessions');
    expect(fallback).not.toHaveBeenCalled();

    const owner = vi.fn();
    register('search-sessions', owner);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('各动作互不影响；取消后不再执行，重复取消无副作用', () => {
    const cancel = defer('new-session');
    const search = vi.fn();
    register('search-sessions', search);
    expect(search).not.toHaveBeenCalled();

    cancel();
    cancel();
    const create = vi.fn();
    register('new-session', create);
    expect(create).not.toHaveBeenCalled();
  });

  it('执行过的那一次的取消函数不影响之后又在等的同一个动作', () => {
    const stale = defer('new-session');
    register('new-session', vi.fn());
    defer('new-session');
    stale();

    const handler = vi.fn();
    register('new-session', handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
