import { EventEmitter } from 'node:events';
import { IPC_CHANNELS, type WindowCloseAction } from '@shared/types/ipc';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureMainLocale } from '../i18n';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
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
vi.mock('../../../resources/icon.ico?asset', () => ({ default: '/test/fynvra.ico' }));
vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  dialog: { showMessageBox: mocks.prompt },
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

import { registerCloseBehavior, respondToClose } from './closeBehavior';

function setup() {
  let quitting = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    hide: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });
  registerCloseBehavior(win as unknown as BrowserWindow, () => quitting);
  return {
    win,
    respond: (action: WindowCloseAction) => respondToClose(win as unknown as BrowserWindow, action),
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
});
const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  configureMainLocale(null);
  vi.restoreAllMocks();
});

describe('应用内关窗选择与托盘', () => {
  it('Windows 托盘使用多尺寸 ico，由系统按 DPI 选尺寸', () => {
    setPlatform('win32');
    const { close, respond } = setup();
    close();
    expect(respond('tray')).toEqual({ ok: true });
    expect(mocks.loadImage).toHaveBeenCalledWith('/test/fynvra.ico');
    expect(mocks.image.resize).not.toHaveBeenCalled();
    expect(mocks.createTray).toHaveBeenCalledWith(mocks.image);
  });

  it('只通知当前 Renderer 显示弹窗，不调用系统消息框；取消后没有关闭副作用', () => {
    const { win, close, respond } = setup();
    expect(close().preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(respond('cancel')).toEqual({ ok: true });
    expect(win.hide).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.createTray).not.toHaveBeenCalled();
  });

  it('没有待处理关窗、取消后和其他窗口的回答都不能触发退出或隐藏', () => {
    const first = setup();
    const other = setup();
    first.respond('quit');
    first.respond('tray');
    first.close();
    other.respond('quit');
    first.respond('cancel');
    first.respond('quit');
    first.respond('tray');
    expect(first.win.hide).not.toHaveBeenCalled();
    expect(other.win.hide).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('最小化只隐藏，重复回答无副作用；点击/菜单恢复，明确退出先显示窗口', () => {
    setPlatform('linux');
    const { win, close, respond } = setup();
    close();
    win.show.mockClear();
    win.focus.mockClear();
    expect(respond('tray')).toEqual({ ok: true });
    respond('tray');
    respond('quit');
    expect(win.hide).toHaveBeenCalledOnce();
    expect(mocks.loadImage).toHaveBeenCalledWith('/test/fynvra.png');
    expect(mocks.image.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
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
    configureMainLocale({ language: () => 'en', systemLanguages: () => [] });
    close();
    respond('tray');
    expect(win.hide).toHaveBeenCalledTimes(2);
    expect(mocks.createTray).toHaveBeenCalledOnce();
    expect(mocks.setMenu.mock.calls.at(-1)?.[0][0].label).toBe('Show Fynvra');
    win.emit('closed');
    expect(mocks.destroyTray).toHaveBeenCalledOnce();
  });

  it('选择退出走 app.quit；退出/更新期间放行关闭，取消未保存确认后重新询问', () => {
    const { win, close, respond, setQuitting } = setup();
    close();
    expect(respond('quit')).toEqual({ ok: true });
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(win.hide).not.toHaveBeenCalled();
    setQuitting(true);
    expect(close().preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledOnce();
    setQuitting(false);
    expect(close().preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    respond('cancel');
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it.each(['quitting', 'destroyed'] as const)('%s 后忽略迟到回答', (state) => {
    const { win, close, respond, setQuitting } = setup();
    close();
    if (state === 'quitting') setQuitting(true);
    else win.isDestroyed.mockReturnValue(true);
    respond('tray');
    respond('quit');
    expect(win.hide).not.toHaveBeenCalled();
    expect(mocks.createTray).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('每次关窗都会通知，Renderer 重载后仍可重新打开弹窗', () => {
    const { win, close } = setup();
    close();
    close();
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('托盘创建失败返回错误给弹窗，不隐藏窗口，保留请求以便重试', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createTray.mockImplementationOnce(() => {
      throw new Error('tray unavailable');
    });
    const { win, close, respond } = setup();
    close();
    expect(respond('tray')).toMatchObject({ ok: false, error: expect.any(String) });
    expect(win.hide).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(respond('tray')).toEqual({ ok: true });
    expect(win.hide).toHaveBeenCalledOnce();
  });
});
