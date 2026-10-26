import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  summary: vi.fn(),
  directories: [] as string[],
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/app-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../services/usage/service', () => ({
  UsageService: class {
    constructor(directory: string) {
      mocks.directories.push(directory);
    }
    summary = mocks.summary;
  },
}));

import { parseUsageInput, registerUsageHandlers } from './usage';

const invoke = (raw: unknown) => mocks.handlers.get(IPC_CHANNELS.USAGE_SUMMARY)?.({}, raw);

describe('usage IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerUsageHandlers();
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

  it('does not throw service errors across IPC', async () => {
    mocks.summary.mockRejectedValueOnce(new Error('read failed'));
    expect(await invoke({ range: '7d' })).toEqual({ ok: false, error: 'read failed' });
  });
});
