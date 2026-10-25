import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationsApi } from './notifications';

const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const ipc = { invoke: invoke as never };
const listeners = new Map<string, (...args: unknown[]) => void>();
const unsubscribe = vi.fn();
const subscribe = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
  listeners.set(channel, listener);
  return unsubscribe;
});

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
});

describe('window.fynvra.notifications', () => {
  it('test 不带参数；setViewing 只传会话 id（或 null）', async () => {
    const api = createNotificationsApi(ipc, subscribe);
    expect(Object.keys(api).sort()).toEqual(['onFocusSession', 'setViewing', 'test']);

    await api.test();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.NOTIFICATIONS_TEST);
    await api.setViewing('session-1');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, {
      sessionId: 'session-1',
    });
    await api.setViewing(null);
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, {
      sessionId: null,
    });
  });

  it('onFocusSession 只交出会话与工作区 id，形状不对的推送丢弃', () => {
    const api = createNotificationsApi(ipc, subscribe);
    const callback = vi.fn();
    expect(api.onFocusSession(callback)).toBe(unsubscribe);
    const listener = listeners.get(IPC_CHANNELS.SESSIONS_FOCUS);

    listener?.({ sessionId: 'session-1', workspaceId: 'ws-1', extra: true });
    expect(callback).toHaveBeenCalledWith({ sessionId: 'session-1', workspaceId: 'ws-1' });
    for (const bad of [
      undefined,
      'session-1',
      { sessionId: 'session-1' },
      { sessionId: 1, workspaceId: 'ws-1' },
    ]) {
      listener?.(bad);
    }
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
