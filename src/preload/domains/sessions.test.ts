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
  it('preserves the cold recovery hint and zero read watermark without inventing runtime data', async () => {
    const { ipc, invoke } = fakeIpc();
    const response = {
      ok: true,
      messages: [],
      contextRecovery: { recoveryRequired: true },
      contextRuntimeSeq: 0,
    };
    invoke.mockResolvedValueOnce(response);
    const result = await createSessionsApi(ipc).history('s-1');
    expect(result).toEqual(response);
    if (!result.ok) throw new Error(result.error);
    expect(result.contextRecovery?.recoveryRequired).toBe(true);
    expect(result.contextRuntime).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSIONS_HISTORY, 's-1');
  });
  it('maps every method to its channel and passes only ids, text and pasted images', async () => {
    const { ipc, invoke } = fakeIpc();
    const api = createSessionsApi(ipc);
    await api.list('ws-1');
    await api.create({ workspaceId: 'ws-1', roleId: 'worker' });
    await api.remove('s-1');
    await api.prompt({ sessionId: 's-1', text: 'hi' });
    await api.prompt({
      sessionId: 's-1',
      text: '',
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    });
    await api.steer({ sessionId: 's-1', text: 'also check docs' });
    await api.retryCompaction('s-1');
    await api.abort('s-1');
    await api.history('s-1');
    await api.respondApproval({ sessionId: 's-1', requestId: 'r-1', decision: 'allow' });
    await api.setModel({
      sessionId: 's-1',
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'high' },
    });
    await api.modelOptions({ workspaceId: 'ws-1' });
    await api.modelOptions();
    await api.setApprovalMode({ sessionId: 's-1', mode: 'full' });
    await api.list('ws-1', { includeArchived: true });
    await api.list('ws-1', { includeArchived: false });
    await api.archive('s-1');
    await api.unarchive('s-1');
    await api.sweep();
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.SESSIONS_LIST, 'ws-1'],
      [IPC_CHANNELS.SESSIONS_CREATE, { workspaceId: 'ws-1', roleId: 'worker' }],
      [IPC_CHANNELS.SESSIONS_REMOVE, 's-1'],
      [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: 'hi' }],
      [
        IPC_CHANNELS.SESSIONS_PROMPT,
        {
          sessionId: 's-1',
          text: '',
          images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        },
      ],
      [IPC_CHANNELS.SESSIONS_STEER, { sessionId: 's-1', text: 'also check docs' }],
      [IPC_CHANNELS.SESSIONS_RETRY_COMPACTION, 's-1'],
      [IPC_CHANNELS.SESSIONS_ABORT, 's-1'],
      [IPC_CHANNELS.SESSIONS_HISTORY, 's-1'],
      [
        IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL,
        { sessionId: 's-1', requestId: 'r-1', decision: 'allow' },
      ],
      [
        IPC_CHANNELS.SESSIONS_SET_MODEL,
        { sessionId: 's-1', model: { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'high' } },
      ],
      [IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, { workspaceId: 'ws-1' }],
      [IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, {}],
      [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1', mode: 'full' }],
      [IPC_CHANNELS.SESSIONS_LIST, { workspaceId: 'ws-1', includeArchived: true }],
      [IPC_CHANNELS.SESSIONS_LIST, 'ws-1'],
      [IPC_CHANNELS.SESSIONS_ARCHIVE, 's-1'],
      [IPC_CHANNELS.SESSIONS_UNARCHIVE, 's-1'],
      [IPC_CHANNELS.SESSIONS_SWEEP],
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
