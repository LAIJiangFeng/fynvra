import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  availableShells: vi.fn(async () => []),
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('node-pty', () => ({
  spawn: () => ({ kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }),
}));
vi.mock('./settings', () => ({
  getSettingsFile: () => ({ read: () => ({ preferences: { terminalShell: { kind: 'pwsh' } } }) }),
}));
vi.mock('./workspaces', () => ({
  getWorkspaceService: () => ({ get: () => ({ repoPath: '/registered-repo' }) }),
}));
vi.mock('../services/shells', () => ({
  shellDetectionDeps: () => ({ platform: 'linux' }),
  availableShells: mocks.availableShells,
  resolveTerminalShell: () => ({ path: '/bin/bash', args: ['-l'] }),
}));

import { registerTerminalHandlers } from './terminals';

describe('terminal shell detection', () => {
  it('reuses the detected shells for the next terminal', async () => {
    registerTerminalHandlers();
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
    const create = (id: string) =>
      mocks.handlers.get(IPC_CHANNELS.TERMINALS_CREATE)?.(
        { sender },
        { id, workspaceId: 'ws-1', cols: 80, rows: 24 }
      );
    expect(await create('11111111-1111-1111-1111-111111111111')).toEqual({ ok: true });
    expect(await create('22222222-2222-2222-2222-222222222222')).toEqual({ ok: true });
    expect(mocks.availableShells).toHaveBeenCalledTimes(1);
  });
});
