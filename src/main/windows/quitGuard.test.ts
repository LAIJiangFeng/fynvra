import { describe, expect, it, vi } from 'vitest';
import { createQuitGuard } from './quitGuard';

describe('退出收尾顺序', () => {
  it('Mac 普通关窗不退出、不收尾；明确退出后才走安装收尾', async () => {
    const quit = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const completeQuit = vi.fn();
    const guard = createQuitGuard({ windows: () => [], quit, shutdown, completeQuit, mac: true });
    guard.allWindowsClosed();
    expect(quit).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    guard.beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(completeQuit).toHaveBeenCalledOnce());
    expect(shutdown).toHaveBeenCalledOnce();
  });
  it('窗口关闭只触发正常退出，更新安装回调必须等服务收尾完成', async () => {
    let complete!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const quit = vi.fn();
    const completeQuit = vi.fn();
    const guard = createQuitGuard({ windows: () => [], shutdown, quit, completeQuit, mac: false });
    guard.allWindowsClosed();
    expect(quit).toHaveBeenCalledOnce();
    expect(completeQuit).not.toHaveBeenCalled();
    guard.beforeQuit({ preventDefault: vi.fn() });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(completeQuit).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(completeQuit).toHaveBeenCalledOnce());
    expect(quit).toHaveBeenCalledOnce();
  });
  it('先让窗口确认，取消退出不能停止服务', () => {
    const close = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const quit = vi.fn();
    const guard = createQuitGuard({ windows: () => [{ close }], shutdown, quit, mac: true });
    const event = { preventDefault: vi.fn() };
    expect(guard.isQuitRequested()).toBe(false);
    guard.beforeQuit(event);
    expect(guard.isQuitRequested()).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    guard.cancel();
    expect(guard.isQuitRequested()).toBe(false);
    guard.allWindowsClosed();
    expect(quit).not.toHaveBeenCalled();
  });
  it('所有窗口确认关闭后才收尾，重复退出不会提前结束收尾', async () => {
    let complete!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const quit = vi.fn();
    const guard = createQuitGuard({ windows: () => [], shutdown, quit, mac: false });
    const event = { preventDefault: vi.fn() };
    guard.beforeQuit(event);
    guard.beforeQuit(event);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    complete();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    guard.beforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
});
