import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FynvraApi } from './types';

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));

let api: FynvraApi;

beforeAll(async () => {
  await import('./index');
  api = mocks.exposeInMainWorld.mock.calls[0]?.[1];
});

describe('preload bridge', () => {
  it('只以 window.fynvra 按领域暴露 API，不提供通用 invoke', () => {
    expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(mocks.exposeInMainWorld.mock.calls[0]?.[0]).toBe('fynvra');
    expect(Object.keys(api).sort()).toEqual([
      'mcp',
      'orchestration',
      'providers',
      'roles',
      'sessions',
      'settings',
      'skills',
      'window',
      'workspaces',
    ]);
    const members = Object.values(api).flatMap(Object.keys);
    expect(members).not.toContain('invoke');
    expect(members).not.toContain('send');
  });

  it('方法映射到对应通道；挂入工作区不传参数，移除只传 id', async () => {
    await api.settings.update({ theme: 'dark' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_UPDATE, { theme: 'dark' });
    await api.workspaces.add();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.WORKSPACES_ADD);
    await api.workspaces.remove('ws-1');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.WORKSPACES_REMOVE, 'ws-1');
  });

  it('订阅回调拿不到 IpcRendererEvent，取消订阅移除同一个 listener', () => {
    const callback = vi.fn();
    const unsubscribe = api.window.onMaximizedChange(callback);
    const [channel, listener] = mocks.on.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED);

    listener({ sender: { send: vi.fn() } }, true);
    expect(callback).toHaveBeenCalledWith(true);
    expect(callback.mock.calls[0]).toHaveLength(1);

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED,
      listener
    );
  });
});
