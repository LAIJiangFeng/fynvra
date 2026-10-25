import { describe, expect, it } from 'vitest';
import { parseDirectoryRequest, parseFileRequest, parseWriteRequest } from './files';

describe('文件 IPC 入参', () => {
  it('保存只接收工作区、文件 id、读取版本与正文，空正文有效', () => {
    const input = { workspaceId: 'ws', fileId: 'file', version: 'a'.repeat(64), text: '' };
    expect(parseWriteRequest(input)).toEqual(input);
    for (const invalid of [
      { ...input, path: '/outside' },
      { ...input, version: '' },
      { ...input, version: 1 },
      { ...input, fileId: '../file' },
      { ...input, text: 1 },
      { ...input, text: 'x'.repeat(256 * 1024 + 1) },
    ])
      expect(parseWriteRequest(invalid)).toBeNull();
  });
  it('根目录只需要工作区 id，子目录和文件只接收不透明 id', () => {
    expect(parseDirectoryRequest({ workspaceId: 'ws-1' })).toEqual({ workspaceId: 'ws-1' });
    expect(parseDirectoryRequest({ workspaceId: 'ws-1', directoryId: 'dir-1' })).toEqual({
      workspaceId: 'ws-1',
      directoryId: 'dir-1',
    });
    expect(parseFileRequest({ workspaceId: 'ws-1', fileId: 'file-1' })).toEqual({
      workspaceId: 'ws-1',
      fileId: 'file-1',
    });
  });

  it.each([
    null,
    [],
    1,
    {},
    { workspaceId: '../repo' },
    { workspaceId: 'ws', path: 'a.txt' },
    { workspaceId: 'ws', directoryId: '../secret' },
    { workspaceId: 'ws', directoryId: null },
    { workspaceId: 'ws', directoryId: 'C:\\secret' },
  ])('拒绝目录非法入参 %j', (raw) => {
    expect(parseDirectoryRequest(raw)).toBeNull();
  });

  it.each([
    null,
    {},
    { workspaceId: 'ws' },
    { workspaceId: 'ws', fileId: '/etc/passwd' },
    { workspaceId: 'ws', fileId: 'id', path: 'secret' },
  ])('拒绝文件非法入参 %j', (raw) => {
    expect(parseFileRequest(raw)).toBeNull();
  });
});
