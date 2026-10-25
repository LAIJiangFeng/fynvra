import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createUpdatesApi } from './updates';

describe('更新 preload 出口', () => {
  it('所有操作无参数，订阅只转发状态并可取消', async () => {
    const invoke = vi.fn(async (_channel: string): Promise<unknown> => ({ ok: true }));
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const api = createUpdatesApi(
      { invoke: <T>(channel: string) => invoke(channel) as Promise<T> },
      subscribe
    );
    await api.state();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.UPDATES_STATE);
    await api.check();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.UPDATES_CHECK);
    await api.install();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.UPDATES_INSTALL);
    const callback = vi.fn();
    expect(api.onChanged(callback)).toBe(unsubscribe);
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.UPDATES_CHANGED, expect.any(Function));
  });
});
