import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  status: vi.fn(),
  install: vi.fn(),
  setIdentity: vi.fn(),
  refreshVcs: vi.fn(async () => {}),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp' },
  net: { fetch: vi.fn() },
}));
vi.mock('../services/gitSetup', () => ({
  createGitSetup: () => mocks,
  defaultExec: vi.fn(),
}));
vi.mock('./workspaces', () => ({ getWorkspaceService: () => ({ refreshVcs: mocks.refreshVcs }) }));

import { registerGitHandlers } from './git';

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);
const STATUS = {
  available: true,
  version: '2.56.1',
  source: 'bundled',
  userName: '',
  userEmail: '',
};

describe('git IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.status.mockResolvedValue(STATUS);
    mocks.install.mockResolvedValue({ status: STATUS });
    mocks.setIdentity.mockResolvedValue(STATUS);
    registerGitHandlers();
  });

  it('三个通道都已注册', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(
      [IPC_CHANNELS.GIT_INSTALL, IPC_CHANNELS.GIT_SET_IDENTITY, IPC_CHANNELS.GIT_STATUS].sort()
    );
  });

  it('入参非法返回 ok: false，不调用服务', async () => {
    for (const input of [null, 'https://example.com/git.zip', { path: 'C:\\evil' }]) {
      expect(await invoke(IPC_CHANNELS.GIT_STATUS, input)).toMatchObject({ ok: false });
      expect(await invoke(IPC_CHANNELS.GIT_INSTALL, input)).toMatchObject({ ok: false });
    }
    for (const input of [undefined, null, 'x', { name: 'a' }, { name: 1, email: 'a@b' }]) {
      expect(await invoke(IPC_CHANNELS.GIT_SET_IDENTITY, input)).toMatchObject({ ok: false });
    }
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.setIdentity).not.toHaveBeenCalled();
  });

  it('安装成功后刷新普通目录工作区的 vcs；服务异常不跨 IPC 抛出', async () => {
    expect(await invoke(IPC_CHANNELS.GIT_INSTALL)).toEqual({ ok: true, status: STATUS });
    expect(mocks.refreshVcs).toHaveBeenCalledWith(undefined, { onlyPlain: true });
    mocks.setIdentity.mockRejectedValueOnce(new Error('邮箱无效'));
    expect(await invoke(IPC_CHANNELS.GIT_SET_IDENTITY, { name: 'Ada', email: 'bad' })).toEqual({
      ok: false,
      error: '邮箱无效',
    });
  });
});
