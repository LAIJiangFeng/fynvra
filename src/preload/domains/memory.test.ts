import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryApi } from './memory';

describe('memory 领域的 preload API', () => {
  it('方法映射到对应通道，只传 id 与字段', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const unsubscribe = vi.fn();
    let pushed: ((...args: unknown[]) => void) | undefined;
    const subscribe = vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
      pushed = listener;
      return unsubscribe;
    });
    const memory = createMemoryApi({ invoke: invoke as never }, subscribe);

    await memory.list('w1');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MEMORY_LIST, { workspaceId: 'w1' });
    const create = { workspaceId: 'w1', category: 'rule' as const, content: 'x' };
    await memory.create(create);
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MEMORY_CREATE, create);
    await memory.update({ workspaceId: 'w1', id: 1, pinned: true });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MEMORY_UPDATE, {
      workspaceId: 'w1',
      id: 1,
      pinned: true,
    });
    await memory.remove({ workspaceId: 'w1', id: 1 });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MEMORY_REMOVE, {
      workspaceId: 'w1',
      id: 1,
    });
    await memory.clear('w1');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MEMORY_CLEAR, { workspaceId: 'w1' });

    const listener = vi.fn();
    expect(memory.onChanged(listener)).toBe(unsubscribe);
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, expect.any(Function));
    pushed?.({ workspaceIds: ['w1', 2] });
    pushed?.(undefined);
    expect(listener.mock.calls).toEqual([[{ workspaceIds: ['w1'] }], [{ workspaceIds: [] }]]);
  });
});
