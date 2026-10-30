import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationApi } from './orchestration';

const ipc = {
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
  on: vi.fn(),
  removeListener: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('window.fynvra.orchestration', () => {
  it('方法映射到 §9.4 通道，只传 id 与 cursor', async () => {
    const api = createOrchestrationApi(ipc);
    expect(Object.keys(api).sort()).toEqual([
      'changes',
      'changesAction',
      'onChanged',
      'readWorkerOutput',
      'reviewDiff',
      'snapshot',
    ]);

    await api.changes({ workspaceId: 'ws-1' });
    expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ORCHESTRATION_CHANGES, {
      workspaceId: 'ws-1',
    });
    const changesInput = {
      workspaceId: 'ws-1',
      sessionId: 'session_1',
      cwd: '/untrusted',
      branch: 'bad',
    };
    await api.changes(changesInput);
    expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ORCHESTRATION_CHANGES, {
      workspaceId: 'ws-1',
      sessionId: 'session_1',
    });

    await api.snapshot('ws-1');
    expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ORCHESTRATION_SNAPSHOT, 'ws-1');

    const input = { dispatchId: 'dispatch_1', cursor: 5, extra: 'dropped' };
    await api.readWorkerOutput(input);
    expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ORCHESTRATION_READ_WORKER_OUTPUT, {
      dispatchId: 'dispatch_1',
      cursor: 5,
    });

    await api.reviewDiff('dispatch_1');
    expect(ipc.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.ORCHESTRATION_REVIEW_DIFF,
      'dispatch_1'
    );
  });

  it('onChanged 只把 workspaceId 交给回调；取消订阅移除同一个 listener', () => {
    const api = createOrchestrationApi(ipc);
    const callback = vi.fn();
    const unsubscribe = api.onChanged(callback);
    const [channel, listener] = ipc.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC_CHANNELS.ORCHESTRATION_CHANGED);

    listener({ sender: { send: vi.fn() } }, 'ws-1');
    expect(callback).toHaveBeenCalledWith('ws-1');
    expect(callback.mock.calls[0]).toHaveLength(1);
    listener({}, 42);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.ORCHESTRATION_CHANGED, listener);
  });
});
