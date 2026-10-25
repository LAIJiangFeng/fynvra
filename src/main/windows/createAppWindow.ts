import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme, shell } from 'electron';
import { registerFileUnloadGuard } from './fileUnloadGuard';

/** 与 styles/globals.css 的 --background 一致，避免首帧闪白 / 闪黑。 */
const BACKGROUND = { light: '#ffffff', dark: '#09090b' } as const;

export type AppWindowOptions = Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'minWidth' | 'minHeight'
>;

/**
 * 创建应用窗口：
 * - contextIsolation + sandbox，Renderer 只能经 preload 暴露的 `window.fynvra` 访问 Main；
 * - macOS 保留红绿灯，Windows / Linux 隐藏系统标题栏和窗口按钮，由 Renderer 自绘。
 */
export function createAppWindow(options: AppWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options,
    show: false,
    title: 'Fynvra',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  registerFileUnloadGuard(win);
  win.on('maximize', () => sendToWindow(win, IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, true));
  win.on('unmaximize', () => sendToWindow(win, IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, false));

  // 外链交给系统浏览器；应用内不开新窗口，也不允许页面跳离本地 UI（重载除外）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    if (event.url !== win.webContents.getURL()) event.preventDefault();
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

export function sendToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

/** Main → Renderer 广播：推送到所有存活窗口。 */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, channel, ...args);
}
