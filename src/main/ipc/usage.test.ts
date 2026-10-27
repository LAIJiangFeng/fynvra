import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageContext } from '../services/usage/aggregate';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  summary: vi.fn(),
  directories: [] as string[],
  contexts: [] as (() => Promise<UsageContext>)[],
  sessions: vi.fn(() => []),
  workspaces: vi.fn(() => [
    { id: 'ws', name: 'Public name', displayPath: '/private/path', vcs: 'git' as const },
  ]),
  snapshot: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/app-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('./sessions', () => ({ getSessionStore: vi.fn() }));
vi.mock('./workspaces', () => ({ getWorkspaceService: vi.fn() }));
vi.mock('./orchestration', () => ({ getOrchestrationRegistry: vi.fn() }));
vi.mock('../services/usage/service', () => ({
  readUsageFile: vi.fn(),
  UsageService: class {
    constructor(
      directory: string,
      _read: unknown,
      _now: unknown,
      context: () => Promise<UsageContext>
    ) {
      mocks.directories.push(directory);
      mocks.contexts.push(context);
    }
    summary = mocks.summary;
  },
}));

import { parseUsageInput, registerUsageHandlers } from './usage';

const invoke = (raw: unknown) => mocks.handlers.get(IPC_CHANNELS.USAGE_SUMMARY)?.({}, raw);

describe('usage IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directories.length = 0;
    mocks.contexts.length = 0;
    registerUsageHandlers({
      getSessions: () => ({ all: mocks.sessions }),
      getWorkspaces: () => ({ list: mocks.workspaces }),
      getOrchestration: () => ({ readSnapshot: mocks.snapshot }),
    });
  });

  it.each([
    undefined,
    null,
    [],
    '7d',
    {},
    { range: 7 },
    { range: 'all' },
    { range: '7d', path: '/other' },
    { range: 'today', sessionId: 's' },
  ])('rejects invalid input %j before accessing files', async (raw) => {
    expect(parseUsageInput(raw)).toBeNull();
    expect(await invoke(raw)).toMatchObject({ ok: false });
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.workspaces).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });

  it('accepts only supported ranges and derives the directory in Main', async () => {
    for (const range of ['today', '7d', '30d', '90d']) {
      expect(parseUsageInput({ range })).toEqual({ range });
      mocks.summary.mockResolvedValueOnce({ range });
      expect(await invoke({ range })).toEqual({ ok: true, summary: { range } });
      expect(mocks.summary).toHaveBeenLastCalledWith(range);
    }
    expect(mocks.directories).toEqual([join('/app-data', 'agent', 'sessions')]);
  });

  it('gets fresh registry dependencies in Main and forwards only workspace names', async () => {
    mocks.summary.mockResolvedValue({});
    await invoke({ range: 'today' });
    const snapshot = { runs: [], tasks: [], dispatches: [], worktrees: [], messages: [] };
    mocks.snapshot.mockResolvedValue(snapshot);
    expect(await mocks.contexts[0]()).toEqual({
      sessions: [],
      workspaces: [{ id: 'ws', name: 'Public name' }],
      snapshots: [{ workspaceId: 'ws', snapshot }],
    });
    expect(mocks.snapshot).toHaveBeenCalledWith('ws');
    mocks.snapshot.mockResolvedValue(undefined);
    expect((await mocks.contexts[0]()).snapshots).toEqual([]);
    expect(mocks.sessions).toHaveBeenCalledTimes(2);
  });

  it('does not throw service errors across IPC', async () => {
    mocks.summary.mockRejectedValueOnce(new Error('read failed'));
    expect(await invoke({ range: '7d' })).toEqual({ ok: false, error: 'read failed' });
  });
});
