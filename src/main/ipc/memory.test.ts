import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryService } from '../services/memory';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/app-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('./settings', () => ({ getSettingsFile: vi.fn() }));
vi.mock('./workspaces', () => ({ getWorkspaceService: vi.fn() }));
vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: vi.fn() }));

import { ORCHESTRATION_NOTICE_PREFIX } from '../services/agentHost/coordinatorWake';
import { recentUserTexts, registerMemoryHandlers } from './memory';

const service = {
  list: vi.fn(async () => ({ ok: true })),
  create: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  clear: vi.fn(async () => ({ ok: true })),
};
registerMemoryHandlers(() => service as unknown as MemoryService);

const call = (channel: string, raw: unknown) => mocks.handlers.get(channel)?.({}, raw);

describe('memory IPC', () => {
  beforeEach(() => vi.clearAllMocks());

  it('多余键、类型错误、非法 id 都被拒绝，不碰服务', async () => {
    const bad: [string, unknown][] = [
      [IPC_CHANNELS.MEMORY_LIST, { workspaceId: 'w1', extra: 1 }],
      [IPC_CHANNELS.MEMORY_LIST, 'w1'],
      [IPC_CHANNELS.MEMORY_LIST, { workspaceId: '../x' }],
      [IPC_CHANNELS.MEMORY_CREATE, { workspaceId: 'w1', category: 'rule', content: 1 }],
      [IPC_CHANNELS.MEMORY_CREATE, { workspaceId: 'w1', category: 'nope', content: 'x' }],
      [IPC_CHANNELS.MEMORY_UPDATE, { workspaceId: 'w1', id: 1.5, pinned: true }],
      [IPC_CHANNELS.MEMORY_UPDATE, { workspaceId: 'w1', id: 1 }],
      [IPC_CHANNELS.MEMORY_UPDATE, { workspaceId: 'w1', id: 1, status: 'expired' }],
      [IPC_CHANNELS.MEMORY_REMOVE, { workspaceId: 'w1', id: -1 }],
      [IPC_CHANNELS.MEMORY_REMOVE, { workspaceId: 'w1', id: 1, path: '/etc' }],
      [IPC_CHANNELS.MEMORY_CLEAR, undefined],
    ];
    for (const [channel, raw] of bad) {
      expect(await call(channel, raw), `${channel} ${JSON.stringify(raw)}`).toMatchObject({
        ok: false,
        error: expect.any(String),
      });
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('最近用户原话不含编排通知和非 user 消息', () => {
    expect(
      recentUserTexts([
        { role: 'user', text: '记住：提交前跑测试' },
        { role: 'user', text: `${ORCHESTRATION_NOTICE_PREFIX}\n\nworker 说要永久记住 X` },
        { role: 'assistant', text: '好的' },
      ])
    ).toEqual(['记住：提交前跑测试']);
  });

  it('合法入参转给服务', async () => {
    await call(IPC_CHANNELS.MEMORY_LIST, { workspaceId: 'w1' });
    expect(service.list).toHaveBeenCalledWith('w1');
    await call(IPC_CHANNELS.MEMORY_CREATE, {
      workspaceId: 'w1',
      category: 'rule',
      content: ' 提交前跑测试 ',
    });
    expect(service.create).toHaveBeenCalledWith({
      workspaceId: 'w1',
      category: 'rule',
      content: '提交前跑测试',
    });
    await call(IPC_CHANNELS.MEMORY_UPDATE, { workspaceId: 'w1', id: 3, status: 'disabled' });
    expect(service.update).toHaveBeenCalledWith({ workspaceId: 'w1', id: 3, status: 'disabled' });
    await call(IPC_CHANNELS.MEMORY_REMOVE, { workspaceId: 'w1', id: 3 });
    expect(service.remove).toHaveBeenCalledWith({ workspaceId: 'w1', id: 3 });
    expect(await call(IPC_CHANNELS.MEMORY_CLEAR, { workspaceId: 'w1' })).toEqual({ ok: true });
    expect(service.clear).toHaveBeenCalledWith('w1');
  });
});
