import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCommandNetwork } from '../services/commandNetwork';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
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
vi.mock('./settings', () => ({ getSettingsFile: () => ({ read: () => ({ preferences: {} }) }) }));
vi.mock('./workspaces', () => ({
  getWorkspaceService: () => ({ get: () => ({ repoPath: '/registered-repo' }) }),
}));
vi.mock('../services/shells', () => ({
  shellDetectionDeps: () => ({ platform: 'linux' }),
  availableShells: async () => [],
  resolveTerminalShell: () => ({ path: '/bin/bash', args: ['-l'] }),
}));

import { registerTerminalHandlers } from './terminals';

afterEach(() => configureCommandNetwork(() => undefined));

describe('new PTY proxy snapshot', () => {
  it('passes saved proxy/compatibility env while retaining cwd, shell and terminal colors', async () => {
    configureCommandNetwork(() => ({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
      gitCompatibility: true,
    }));
    const pty = { kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    mocks.spawn.mockReturnValue(pty);
    registerTerminalHandlers();
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
    const result = await mocks.handlers.get(IPC_CHANNELS.TERMINALS_CREATE)?.(
      { sender },
      {
        id: '11111111-1111-1111-1111-111111111111',
        workspaceId: 'ws-1',
        cols: 80,
        rows: 24,
      }
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-l'],
      expect.objectContaining({
        cwd: '/registered-repo',
        env: expect.objectContaining({
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
          NO_PROXY: '',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        }),
      })
    );
    configureCommandNetwork(() => undefined);
    expect(pty.kill).not.toHaveBeenCalled();
    sender.emit('destroyed');
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });
});
