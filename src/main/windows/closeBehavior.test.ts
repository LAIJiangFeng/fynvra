import { EventEmitter } from 'node:events';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureMainLocale } from '../i18n';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  error: vi.fn(),
  quit: vi.fn(),
  createTray: vi.fn(),
  destroyTray: vi.fn(),
  setMenu: vi.fn(),
  tooltip: vi.fn(),
  image: { resize: vi.fn() },
  loadImage: vi.fn(),
  trayEvents: new Map<string, () => void>(),
}));
vi.mock('../../../resources/icon.png?asset', () => ({ default: '/test/fynvra.png' }));
vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  dialog: { showMessageBox: mocks.prompt, showErrorBox: mocks.error },
  nativeImage: { createFromPath: mocks.loadImage },
  Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items },
  Tray: class {
    constructor(image: unknown) {
      mocks.createTray(image);
    }
    on(event: string, callback: () => void) {
      mocks.trayEvents.set(event, callback);
    }
    setToolTip = mocks.tooltip;
    setContextMenu = mocks.setMenu;
    destroy = mocks.destroyTray;
  },
}));

import { registerCloseBehavior } from './closeBehavior';

function setup() {
  let quitting = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    hide: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
  });
  registerCloseBehavior(win as unknown as BrowserWindow, () => quitting);
  return {
    win,
    setQuitting(value: boolean) {
      quitting = value;
    },
    close() {
      const event = { preventDefault: vi.fn() };
      win.emit('close', event);
      return event;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trayEvents.clear();
  mocks.loadImage.mockReturnValue(mocks.image);
  mocks.image.resize.mockReturnValue(mocks.image);
  mocks.prompt.mockResolvedValue({ response: 0 });
});
afterEach(() => {
  configureMainLocale(null);
  vi.restoreAllMocks();
});

describe('关窗选择与托盘', () => {
  it('默认取消，不关窗、不退出、不创建托盘，文案随界面语言', async () => {
    configureMainLocale({ language: () => 'en', systemLanguages: () => [] });
    const { win, close } = setup();
    expect(close().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith(
        win,
        expect.objectContaining({
          buttons: ['Cancel', 'Minimize to tray', 'Quit'],
          defaultId: 0,
          cancelId: 0,
        })
      )
    );
    expect(win.hide).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.createTray).not.toHaveBeenCalled();
  });

  it('最小化只隐藏，复用托盘；点击与菜单可恢复，退出先显示以便确认未保存内容', async () => {
    mocks.prompt.mockResolvedValue({ response: 1 });
    const { win, close } = setup();
    close();
    await vi.waitFor(() => expect(win.hide).toHaveBeenCalledOnce());
    expect(mocks.loadImage).toHaveBeenCalledWith('/test/fynvra.png');
    expect(mocks.createTray).toHaveBeenCalledWith(mocks.image);
    expect(mocks.tooltip).toHaveBeenCalledWith('Fynvra');
    expect(mocks.quit).not.toHaveBeenCalled();
    win.isMinimized.mockReturnValue(true);
    mocks.trayEvents.get('click')?.();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    const menu = mocks.setMenu.mock.calls.at(-1)?.[0] as { label?: string; click?(): void }[];
    expect(menu.map((item) => item.label).filter(Boolean)).toEqual(['显示 Fynvra', '退出']);
    menu[0]?.click?.();
    expect(win.show).toHaveBeenCalledTimes(2);
    menu[2]?.click?.();
    expect(win.show).toHaveBeenCalledTimes(3);
    expect(mocks.quit).toHaveBeenCalledOnce();
    close();
    await vi.waitFor(() => expect(win.hide).toHaveBeenCalledTimes(2));
    expect(mocks.createTray).toHaveBeenCalledOnce();
    win.emit('closed');
    expect(mocks.destroyTray).toHaveBeenCalledOnce();
  });

  it('选择退出走 app.quit；退出/更新期间放行关闭，取消未保存确认后重新询问', async () => {
    mocks.prompt.mockResolvedValue({ response: 2 });
    const { win, close, setQuitting } = setup();
    close();
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
    expect(win.hide).not.toHaveBeenCalled();
    setQuitting(true);
    expect(close().preventDefault).not.toHaveBeenCalled();
    expect(mocks.prompt).toHaveBeenCalledOnce();
    setQuitting(false);
    mocks.prompt.mockResolvedValue({ response: 0 });
    expect(close().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it.each(['quitting', 'destroyed'] as const)(
    '等待回答时重复关窗不叠框，%s 后忽略迟到回答',
    async (state) => {
      let answer!: (result: { response: number }) => void;
      mocks.prompt.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      const { win, close, setQuitting } = setup();
      close();
      close();
      expect(mocks.prompt).toHaveBeenCalledOnce();
      if (state === 'quitting') setQuitting(true);
      else win.isDestroyed.mockReturnValue(true);
      answer({ response: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(win.hide).not.toHaveBeenCalled();
      expect(mocks.createTray).not.toHaveBeenCalled();
    }
  );

  it('托盘创建失败保留窗口并提示，可以再次关闭重试', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.prompt.mockResolvedValue({ response: 1 });
    mocks.createTray.mockImplementationOnce(() => {
      throw new Error('tray unavailable');
    });
    const { win, close } = setup();
    close();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(win.hide).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    close();
    await vi.waitFor(() => expect(win.hide).toHaveBeenCalledOnce());
  });
});
