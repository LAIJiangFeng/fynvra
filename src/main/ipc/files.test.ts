import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../services/files', () => ({
  createFilesService: () => ({ list: mocks.list, read: mocks.read, write: mocks.write }),
}));
vi.mock('./workspaces', () => ({ getWorkspaceService: () => ({ get: vi.fn() }) }));

import { registerFilesHandlers } from './files';

const invoke = (channel: string, input: unknown) => mocks.handlers.get(channel)?.({}, input);

describe('文件 IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFilesHandlers();
  });

  it('未知入参先收窄，路径和额外参数不能到达文件服务', async () => {
    for (const raw of [
      null,
      { workspaceId: 'ws', directoryId: '../outside' },
      { workspaceId: 'ws', path: 'a.txt' },
    ]) {
      expect(await invoke(IPC_CHANNELS.FILES_LIST, raw)).toEqual({
        ok: false,
        error: 'invalidRequest',
      });
    }
    expect(await invoke(IPC_CHANNELS.FILES_READ, { workspaceId: 'ws', fileId: '/secret' })).toEqual(
      { ok: false, error: 'invalidRequest' }
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(
      await invoke(IPC_CHANNELS.FILES_WRITE, { workspaceId: 'ws', fileId: 'file', path: '/secret' })
    ).toEqual({ ok: false, error: 'invalidRequest' });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('只按 id 调用服务，原样返回预览结果', async () => {
    const result = { ok: true, preview: { kind: 'text', text: '内容', size: 6 } };
    mocks.read.mockResolvedValue(result);
    expect(await invoke(IPC_CHANNELS.FILES_READ, { workspaceId: 'ws', fileId: 'file' })).toEqual(
      result
    );
    expect(mocks.read).toHaveBeenCalledWith({ workspaceId: 'ws', fileId: 'file' });
    mocks.list.mockResolvedValue({ ok: true, entries: [], truncated: false });
    await invoke(IPC_CHANNELS.FILES_LIST, { workspaceId: 'ws' });
    expect(mocks.list).toHaveBeenCalledWith({ workspaceId: 'ws' });
  });

  it('意外异常不跨 IPC 抛出或泄露绝对路径', async () => {
    mocks.read.mockRejectedValue(new Error('C:\\private\\secret'));
    expect(await invoke(IPC_CHANNELS.FILES_READ, { workspaceId: 'ws', fileId: 'file' })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('保存传递版本和正文，保持冲突结果', async () => {
    const input = { workspaceId: 'ws', fileId: 'file', version: 'a'.repeat(64), text: '草稿' };
    mocks.write.mockResolvedValue({ ok: false, error: 'conflict' });
    expect(await invoke(IPC_CHANNELS.FILES_WRITE, input)).toEqual({ ok: false, error: 'conflict' });
    expect(mocks.write).toHaveBeenCalledWith(input);
    mocks.write.mockRejectedValue(new Error('私有路径'));
    expect(await invoke(IPC_CHANNELS.FILES_WRITE, input)).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});
