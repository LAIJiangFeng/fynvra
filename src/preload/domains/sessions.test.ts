import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionsApi, type PreloadIpc } from './sessions';

function fakeIpc() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const unsubscribe = vi.fn();
  const ipc = {
    invoke: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener);
      return unsubscribe;
    }),
  };
  return { ipc: ipc as unknown as PreloadIpc, invoke: ipc.invoke, listeners, unsubscribe };
}

describe('createSessionsApi', () => {
  it('maps every method to its channel and passes only ids and text', async () => {
    const { ipc, invoke } = fakeIpc();
    const api = createSessionsApi(ipc);
    await api.list('ws-1');
    await api.create({ workspaceId: 'ws-1', roleId: 'worker' });
    await api.remove('s-1');
    await api.prompt({ sessionId: 's-1', text: 'hi' });
    await api.abort('s-1');
    await api.history('s-1');
    await api.respondApproval({ sessionId: 's-1', requestId: 'r-1', decision: 'allow' });
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.SESSIONS_LIST, 'ws-1'],
      [IPC_CHANNELS.SESSIONS_CREATE, { workspaceId: 'ws-1', roleId: 'worker' }],
      [IPC_CHANNELS.SESSIONS_REMOVE, 's-1'],
      [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: 'hi' }],
      [IPC_CHANNELS.SESSIONS_ABORT, 's-1'],
      [IPC_CHANNELS.SESSIONS_HISTORY, 's-1'],
      [
        IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL,
        { sessionId: 's-1', requestId: 'r-1', decision: 'allow' },
      ],
    ]);
    expect(Object.keys(api)).not.toContain('invoke');
  });

  it('delivers pushes to the callbacks and returns the unsubscribe handle', () => {
    const { ipc, listeners, unsubscribe } = fakeIpc();
    const api = createSessionsApi(ipc);
    const onEvent = vi.fn();
    const onChanged = vi.fn();
    const onApproval = vi.fn();
    expect(api.onEvent(onEvent)).toBe(unsubscribe);
    api.onSessionsChanged(onChanged);
    api.onApprovalRequest(onApproval);

    const envelope = { sessionId: 's-1', event: { type: 'text_delta', delta: 'a', seq: 1 } };
    listeners.get(IPC_CHANNELS.SESSIONS_EVENT)?.(envelope);
    listeners.get(IPC_CHANNELS.SESSIONS_CHANGED)?.('ws-1');
    const request = {
      id: 'r-1',
      sessionId: 's-1',
      kind: 'command',
      title: 'bash',
      detail: 'ls',
      expiresAt: 1,
    };
    listeners.get(IPC_CHANNELS.SESSIONS_APPROVAL_REQUEST)?.(request);

    expect(onEvent).toHaveBeenCalledWith(envelope);
    expect(onChanged).toHaveBeenCalledWith('ws-1');
    expect(onApproval).toHaveBeenCalledWith(request);
  });
});
