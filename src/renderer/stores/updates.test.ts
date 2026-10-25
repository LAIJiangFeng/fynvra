import type { UpdateState } from '@shared/types/updates';
import { describe, expect, it, vi } from 'vitest';
import { createUpdatesStore } from './updates';

const snapshot = (seq: number, status: UpdateState['status']): UpdateState => ({
  seq,
  status,
  currentVersion: '0.1.0',
});

describe('更新界面状态', () => {
  it('先订阅再加载，迟到的读取结果不覆盖推送，卸载可取消订阅', async () => {
    let resolve!: (result: { ok: true; state: UpdateState }) => void;
    let listener!: (state: UpdateState) => void;
    const unsubscribe = vi.fn();
    const api = {
      state: vi.fn(
        () =>
          new Promise<{ ok: true; state: UpdateState }>((done) => {
            resolve = done;
          })
      ),
      check: vi.fn(),
      install: vi.fn(),
      onChanged: vi.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
    };
    const store = createUpdatesStore(api);
    const unbind = store.getState().bind();
    listener(snapshot(2, 'downloaded'));
    resolve({ ok: true, state: snapshot(0, 'idle') });
    await vi.waitFor(() => expect(store.getState().state?.status).toBe('downloaded'));
    await Promise.resolve();
    expect(store.getState().state?.seq).toBe(2);
    unbind();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('请求异常可显示和重试，操作结果同样不能倒退状态', async () => {
    const api = {
      state: vi.fn(async () => ({ ok: true as const, state: snapshot(0, 'idle') })),
      check: vi.fn(async () => ({ ok: true as const, state: snapshot(1, 'checking') })),
      install: vi.fn(async () => {
        throw new Error('IPC 不可用');
      }),
      onChanged: vi.fn(() => () => {}),
    };
    const store = createUpdatesStore(api);
    await store.getState().install();
    expect(store.getState().error).toBe('IPC 不可用');
    await store.getState().check();
    expect(store.getState().error).toBeNull();
    expect(store.getState().state?.status).toBe('checking');
  });
});
