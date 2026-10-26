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
      'files',
      'instructions',
      'mcp',
      'notifications',
      'orchestration',
      'providers',
      'roles',
      'sessions',
      'settings',
      'skills',
      'terminals',
      'updates',
      'usage',
      'window',
      'workspaces',
    ]);
    const members = Object.values(api).flatMap(Object.keys);
    expect(members).not.toContain('invoke');
    expect(members).not.toContain('send');
  });

  it('用量出口只传范围并映射到 summary 通道', async () => {
    await api.usage.summary({ range: '7d' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.USAGE_SUMMARY, { range: '7d' });
  });

  it('方法映射到对应通道；挂入工作区、选 worktree 根目录都不传路径，移除只传 id', async () => {
    await api.settings.update({ theme: 'dark' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_UPDATE, { theme: 'dark' });
    await api.settings.pickWorktreesRoot();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT);
    await api.settings.pickWorktreesRoot({ reset: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_PICK_WORKTREES_ROOT, {
      reset: true,
    });
    await api.settings.worktreesRootInfo();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO);
    await api.settings.worktreesRootInfo({ usage: false });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_WORKTREES_ROOT_INFO, {
      usage: false,
    });
    await api.workspaces.add();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.WORKSPACES_ADD);
    await api.workspaces.remove('ws-1');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.WORKSPACES_REMOVE, 'ws-1');
  });

  it('shell settings use a no-input list and target-only file picker', async () => {
    await api.settings.availableShells();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_AVAILABLE_SHELLS);
    await api.settings.pickShell('agentShell');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_PICK_SHELL, 'agentShell');
    await api.settings.update({ terminalShell: undefined });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SETTINGS_UPDATE, {
      terminalShell: undefined,
    });
  });

  it('exposes instruction operations with IDs and user values, and strips push events', async () => {
    await api.instructions.list();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_LIST);
    await api.instructions.scan();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_SCAN);
    await api.instructions.pick();
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_PICK);
    await api.instructions.import({ candidateIds: ['claude'] });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_IMPORT, {
      candidateIds: ['claude'],
    });
    await api.instructions.save({ name: 'Mine', content: 'text' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_SAVE, {
      name: 'Mine',
      content: 'text',
    });
    await api.instructions.read('file-id');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_READ, 'file-id');
    await api.instructions.remove('file-id');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_REMOVE, 'file-id');
    await api.instructions.toggle({ id: 'file-id', enabled: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.INSTRUCTIONS_TOGGLE, {
      id: 'file-id',
      enabled: true,
    });
    const callback = vi.fn();
    const unsubscribe = api.instructions.onChanged(callback);
    const [channel, listener] = mocks.on.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IPC_CHANNELS.INSTRUCTIONS_CHANGED);
    listener({ sender: {} });
    expect(callback).toHaveBeenCalledWith();
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenLastCalledWith(channel, listener);
  });

  it('文件浏览出口完整接入，目录和预览只传工作区与条目 id', async () => {
    expect(Object.keys(api.files).sort()).toEqual([
      'copy',
      'create',
      'duplicate',
      'list',
      'read',
      'remove',
      'rename',
      'resolve',
      'reveal',
      'write',
    ]);
    await api.files.list({ workspaceId: 'ws-1' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_LIST, {
      workspaceId: 'ws-1',
    });
    await api.files.read({ workspaceId: 'ws-1', fileId: 'file-1' });
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_READ, {
      workspaceId: 'ws-1',
      fileId: 'file-1',
    });
  });

  it('关闭确认只回传操作，推送不泄露 Electron 事件且能解绑', async () => {
    await api.window.respondClose('tray');
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.WINDOW_RESPOND_CLOSE, 'tray');
    const callback = vi.fn();
    const unsubscribe = api.window.onCloseRequested(callback);
    const [channel, listener] = mocks.on.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED);
    listener({ sender: { send: vi.fn() } });
    expect(callback).toHaveBeenCalledWith();
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, listener);
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
