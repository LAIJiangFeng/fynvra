import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  availableShells: vi.fn(async () => []),
  existsSync: vi.fn((_path: string) => true),
  repoPath: '',
  spawn: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('./settings', () => ({
  getSettingsFile: () => ({ read: () => ({ preferences: { terminalShell: { kind: 'pwsh' } } }) }),
}));
vi.mock('./workspaces', () => ({
  getWorkspaceService: () => ({ get: () => ({ repoPath: mocks.repoPath }) }),
}));
vi.mock('../services/shells', () => ({
  shellDetectionDeps: () => ({ platform: 'linux', existsSync: mocks.existsSync }),
  availableShells: mocks.availableShells,
  resolveTerminalShell: (preference: unknown) =>
    preference ? { path: '/opt/custom/zsh', args: ['-l'] } : { path: '/bin/sh', args: ['-l'] },
}));

import { registerTerminalHandlers } from './terminals';

registerTerminalHandlers();
const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
const create = (id: string) =>
  mocks.handlers.get(IPC_CHANNELS.TERMINALS_CREATE)?.(
    { sender },
    { id, workspaceId: 'ws-1', cols: 80, rows: 24 }
  );

beforeEach(() => {
  mocks.existsSync.mockReset().mockReturnValue(true);
  mocks.repoPath = tmpdir();
  mocks.spawn.mockReset().mockReturnValue({ kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() });
});

describe('terminal shell detection', () => {
  it('reuses the detected shells for the next terminal', async () => {
    expect(await create('11111111-1111-1111-1111-111111111111')).toEqual({ ok: true });
    expect(await create('22222222-2222-2222-2222-222222222222')).toEqual({ ok: true });
    expect(mocks.availableShells).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default shell when the selected shell is missing', async () => {
    mocks.existsSync.mockImplementation((path) => path !== '/opt/custom/zsh');
    expect(await create('33333333-3333-3333-3333-333333333333')).toEqual({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith('/bin/sh', ['-l'], expect.anything());
  });

  it('reports a missing workspace folder without spawning', async () => {
    mocks.repoPath = join(tmpdir(), 'fynvra-missing-repo-4f7c2a');
    const result = (await create('44444444-4444-4444-4444-444444444444')) as { error: string };
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain(mocks.repoPath);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('accepts an existing workspace directory even though the shell file check rejects directories', async () => {
    // production existsSync is file-only: true for shells, false for directories
    mocks.existsSync.mockImplementation((path) => path === '/opt/custom/zsh' || path === '/bin/sh');
    expect(await create('66666666-6666-6666-6666-666666666666')).toEqual({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/opt/custom/zsh',
      ['-l'],
      expect.objectContaining({ cwd: mocks.repoPath })
    );
  });

  it('includes the shell and cwd in spawn failures', async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error('posix_spawnp failed.');
    });
    const result = (await create('55555555-5555-5555-5555-555555555555')) as { error: string };
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('posix_spawnp failed.');
    expect(result.error).toContain('/opt/custom/zsh');
    expect(result.error).toContain(mocks.repoPath);
  });
});
