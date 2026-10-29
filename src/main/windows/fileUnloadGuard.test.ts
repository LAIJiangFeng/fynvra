import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UiFlushMode, UiFlushRequest } from '@shared/types/workspaceUi';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { sender: unknown }, raw: unknown) => unknown;
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), handlers: new Map<string, Handler>() }));
vi.mock('electron', () => ({
  app: {},
  dialog: { showMessageBoxSync: mocks.confirm },
  ipcMain: {
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../ipc/files', () => ({ getFilesService: vi.fn() }));
vi.mock('../ipc/terminals', () => ({ terminalBelongsTo: vi.fn() }));
vi.mock('../ipc/workspaces', () => ({ getWorkspaceService: vi.fn() }));

import { prepareWorkspaceWindowClose, registerWorkspaceUiHandlers } from '../ipc/workspaceUi';
import { registerFileUnloadGuard } from './fileUnloadGuard';

function setup() {
  let unload!: (event: { preventDefault(): void }) => void;
  const owner = {
    on: vi.fn((_event: string, callback: typeof unload) => {
      unload = callback;
    }),
    send: vi.fn<(channel: string, request: UiFlushRequest) => void>(),
    reload: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  const win = { webContents: owner, isDestroyed: vi.fn(() => false) };
  registerFileUnloadGuard(win as unknown as BrowserWindow);
  expect(owner.on).toHaveBeenCalledWith('will-prevent-unload', expect.any(Function));
  const event = { preventDefault: vi.fn() };
  unload(event);
  // Reuse the in-flight operation to observe the real acknowledgement contract.
  const pending = prepareWorkspaceWindowClose(win as unknown as BrowserWindow);
  const reply = (mode: UiFlushMode, ok: boolean, dirty: boolean) => {
    const [channel, request] = owner.send.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IPC_CHANNELS.WORKSPACE_UI_FLUSH);
    expect(request?.mode).toBe(mode);
    const handler = mocks.handlers.get(IPC_CHANNELS.WORKSPACE_UI_FLUSHED);
    if (!handler || !request) throw new Error('missing flush handler or request');
    expect(handler({ sender: owner }, { requestId: request.requestId, ok, dirty })).toEqual({
      ok: true,
    });
  };
  return { win, owner, event, pending, reply };
}

describe('未保存文件的原生退出确认', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockReturnValue(0);
    registerWorkspaceUiHandlers();
  });
  afterEach(() => vi.useRealTimers());

  it.each([0, 1, 2])('默认取消，仅明确保留或放弃且落盘成功后重新加载：%s', async (choice) => {
    mocks.confirm.mockReturnValue(choice);
    const { win, owner, event, pending, reply } = setup();
    expect(owner.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    reply('check', true, true);
    await vi.waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        win,
        expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: expect.any(Array) })
      )
    );
    expect(mocks.confirm.mock.calls[0]?.[1].buttons).toHaveLength(3);
    expect(owner.reload).not.toHaveBeenCalled();
    if (choice !== 0) reply(choice === 2 ? 'discard' : 'keep', true, false);
    expect(await pending).toBe(choice !== 0);
    expect(owner.reload).toHaveBeenCalledTimes(choice === 0 ? 0 : 1);
    // Never override Electron's cancellation of the original navigation.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledTimes(choice === 0 ? 1 : 2);
  });

  it('检查失败时保留窗口，不允许重新加载', async () => {
    const { owner, event, pending, reply } = setup();
    reply('check', false, true);
    expect(await pending).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'error' })
    );
    expect(owner.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([1, 2])('保留或放弃的落盘失败仍阻止离开：%s', async (choice) => {
    mocks.confirm.mockReturnValue(choice);
    const { owner, event, pending, reply } = setup();
    reply('check', true, true);
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledTimes(2));
    reply(choice === 2 ? 'discard' : 'keep', false, true);
    expect(await pending).toBe(false);
    expect(owner.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('检查超时阻止离开并恢复 Renderer 输入', async () => {
    vi.useFakeTimers();
    const { owner, event, pending } = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(false);
    expect(owner.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.WORKSPACE_UI_FLUSH,
      expect.objectContaining({ mode: 'resume' })
    );
    expect(owner.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('确认期间已销毁的窗口不会重新加载', async () => {
    const { win, owner, pending, reply } = setup();
    reply('check', true, false);
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledTimes(2));
    expect(mocks.confirm).not.toHaveBeenCalled();
    win.isDestroyed.mockReturnValue(true);
    reply('keep', true, false);
    expect(await pending).toBe(true);
    expect(owner.reload).not.toHaveBeenCalled();
  });
});
