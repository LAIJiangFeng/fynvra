import { IPC_CHANNELS } from '@shared/types/ipc';
import { expect, it, vi } from 'vitest';
import { createFilesApi } from './files';

it('文件出口按 id 读取与保存，不转发路径', async () => {
  const ipc = { invoke: vi.fn(async () => ({ ok: true })) };
  const api = createFilesApi(ipc);
  expect(Object.keys(api).sort()).toEqual([
    'copy',
    'create',
    'duplicate',
    'list',
    'openHtml',
    'read',
    'remove',
    'rename',
    'resolve',
    'reveal',
    'write',
  ]);
  await api.list({ workspaceId: 'ws' });
  expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_LIST, { workspaceId: 'ws' });
  const input = { workspaceId: 'ws', directoryId: 'dir', path: '../outside' };
  await api.list(input);
  expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_LIST, {
    workspaceId: 'ws',
    directoryId: 'dir',
  });
  await api.read({ workspaceId: 'ws', fileId: 'file' });
  expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_READ, {
    workspaceId: 'ws',
    fileId: 'file',
  });
  const write = { workspaceId: 'ws', fileId: 'file', version: 'a'.repeat(64), text: '草稿' };
  await api.write({ ...write, path: '../outside' } as typeof write);
  expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_WRITE, write);
  const html = { workspaceId: 'ws', entryId: 'html', url: 'file:///outside.html' };
  await api.openHtml(html);
  expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.FILES_OPEN_HTML, {
    workspaceId: 'ws',
    entryId: 'html',
  });
});
