import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerActionHandler, runAction } from './handlers';

const cleanups: (() => void)[] = [];
function register(...args: Parameters<typeof registerActionHandler>) {
  const unregister = registerActionHandler(...args);
  cleanups.push(unregister);
  return unregister;
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
