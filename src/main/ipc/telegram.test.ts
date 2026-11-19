import { IPC_CHANNELS } from '@shared/types/ipc';
import type { TelegramStateView } from '@shared/types/telegram';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  service: undefined as unknown,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '', on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
}));

vi.mock('../services/telegram/instance', () => ({
  getTelegramService: () => mocks.service,
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ';
const state: TelegramStateView = {
  enabled: true,
  connection: 'connected',
  tokenMasked: '123456:AB…YZ',
  bot: { id: 1, username: 'fynvra_bot' },
  candidates: [],
  groups: [],
  cards: [],
};

function createService() {
  let listener: (() => void) | undefined;
  return {
    getState: vi.fn(() => state),
    setToken: vi.fn(async () => ({ ok: true })),
    allowGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
    resolveCard: vi.fn(async () => ({ ok: true })),
    setEnabled: vi.fn(async () => ({ ok: true })),
    onChange: vi.fn((next: () => void) => {
      listener = next;
      return () => {};
    }),
    emit: () => listener?.(),
  };
}

let service: ReturnType<typeof createService>;

beforeAll(async () => {
  const { registerTelegramHandlers } = await import('./telegram');
  registerTelegramHandlers();
});

beforeEach(() => {
  service = createService();
  mocks.service = service;
  mocks.send.mockClear();
});

const invalid = { ok: false, error: '无效的参数' };

describe('telegram IPC', () => {
  it('服务未创建时返回可读错误', async () => {
    mocks.service = undefined;
    expect(await invoke(IPC_CHANNELS.TELEGRAM_GET_STATE)).toEqual({
      ok: false,
      error: expect.stringContaining('Telegram 服务尚未启动'),
    });
    expect(await invoke(IPC_CHANNELS.TELEGRAM_SET_ENABLED, { enabled: true })).toEqual({
      ok: false,
      error: expect.stringContaining('Telegram 服务尚未启动'),
    });
  });

  it('get-state 返回视图，不含 token', async () => {
    await invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, { token: TOKEN });
    const result = await invoke(IPC_CHANNELS.TELEGRAM_GET_STATE);
    expect(result).toEqual({ ok: true, state });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('多余的键或非对象入参被拒', async () => {
    const cases: [string, unknown][] = [
      [IPC_CHANNELS.TELEGRAM_SET_TOKEN, { token: null, extra: 1 }],
      [IPC_CHANNELS.TELEGRAM_ALLOW_GROUP, { groupId: 1, workspaceId: 'w', path: 'C:/' }],
      [IPC_CHANNELS.TELEGRAM_REMOVE_GROUP, { groupId: 1, chatId: 1 }],
      [IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, { cardId: 1, action: 'approve', x: true }],
      [IPC_CHANNELS.TELEGRAM_SET_ENABLED, { enabled: true, token: TOKEN }],
      [IPC_CHANNELS.TELEGRAM_SET_ENABLED, null],
      [IPC_CHANNELS.TELEGRAM_SET_ENABLED, [true]],
    ];
    for (const [channel, raw] of cases) expect(await invoke(channel, raw)).toEqual(invalid);
    expect(service.setToken).not.toHaveBeenCalled();
    expect(service.allowGroup).not.toHaveBeenCalled();
    expect(service.removeGroup).not.toHaveBeenCalled();
    expect(service.resolveCard).not.toHaveBeenCalled();
    expect(service.setEnabled).not.toHaveBeenCalled();
  });

  it('groupId / cardId 必须是安全整数', async () => {
    for (const id of [1.5, '1', Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY, undefined]) {
      expect(
        await invoke(IPC_CHANNELS.TELEGRAM_ALLOW_GROUP, { groupId: id, workspaceId: 'w' })
      ).toEqual(invalid);
      expect(await invoke(IPC_CHANNELS.TELEGRAM_REMOVE_GROUP, { groupId: id })).toEqual(invalid);
      expect(
        await invoke(IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, { cardId: id, action: 'approve' })
      ).toEqual(invalid);
    }
    expect(service.allowGroup).not.toHaveBeenCalled();
    expect(service.removeGroup).not.toHaveBeenCalled();
    expect(service.resolveCard).not.toHaveBeenCalled();
  });

  it('action 不在枚举里被拒', async () => {
    for (const action of ['approved', 'APPROVE', '', 1, undefined]) {
      expect(await invoke(IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, { cardId: 1, action })).toEqual(
        invalid
      );
    }
    expect(service.resolveCard).not.toHaveBeenCalled();
  });

  it('token 必须是 string（≤100）或 null', async () => {
    for (const token of [1, undefined, {}, 'x'.repeat(101)]) {
      expect(await invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, { token })).toEqual(invalid);
    }
    expect(service.setToken).not.toHaveBeenCalled();
    expect(await invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, { token: 'x'.repeat(100) })).toEqual({
      ok: true,
    });
    expect(await invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, { token: null })).toEqual({ ok: true });
    expect(service.setToken.mock.calls).toEqual([['x'.repeat(100)], [null]]);
  });

  it('合法入参交给服务，groupId 映射为 chatId；服务错误原样返回', async () => {
    service.allowGroup.mockResolvedValueOnce({ ok: false, error: '只能允许候选群' } as never);
    expect(
      await invoke(IPC_CHANNELS.TELEGRAM_ALLOW_GROUP, { groupId: -100123, workspaceId: 'ws-1' })
    ).toEqual({ ok: false, error: '只能允许候选群' });
    expect(service.allowGroup).toHaveBeenCalledWith(-100123, 'ws-1');
    await invoke(IPC_CHANNELS.TELEGRAM_REMOVE_GROUP, { groupId: -100123 });
    expect(service.removeGroup).toHaveBeenCalledWith(-100123);
    await invoke(IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, { cardId: 7, action: 'reject' });
    expect(service.resolveCard).toHaveBeenCalledWith(7, 'reject');
    await invoke(IPC_CHANNELS.TELEGRAM_SET_ENABLED, { enabled: false });
    expect(service.setEnabled).toHaveBeenCalledWith(false);
  });

  it('connectTelegramChanged 把 onChange 广播为 telegram:changed（不带参数）', async () => {
    const { connectTelegramChanged } = await import('./telegram');
    connectTelegramChanged(service as never);
    service.emit();
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.TELEGRAM_CHANGED);
  });
});
