import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  loadFile: vi.fn(),
  webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
}));
vi.mock('../../../resources/icon.png?asset', () => ({ default: '/test/fynvra.png' }));
vi.mock('../../../resources/icon.ico?asset', () => ({ default: '/test/fynvra.ico' }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      mocks.construct(options);
    }
    on = mocks.on;
    once = mocks.once;
    loadFile = mocks.loadFile;
    webContents = mocks.webContents;
  },
  nativeTheme: { shouldUseDarkColors: false },
  shell: {},
}));
vi.mock('./fileUnloadGuard', () => ({ registerFileUnloadGuard: vi.fn() }));

import { createAppWindow } from './createAppWindow';
import { registerFileUnloadGuard } from './fileUnloadGuard';

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => setPlatform(originalPlatform));
it('Windows 窗口使用多尺寸 ico 作为标题栏与任务栏图标', () => {
  setPlatform('win32');
  createAppWindow({ width: 1280, height: 800 });
  expect(mocks.construct).toHaveBeenCalledWith(
    expect.objectContaining({ icon: '/test/fynvra.ico' })
  );
});

it('运行窗口使用随构建产物提供的 Fynvra 图标，并保留沙箱与未保存保护', () => {
  setPlatform('linux');
  const win = createAppWindow({ width: 1280, height: 800 });
  expect(registerFileUnloadGuard).toHaveBeenCalledWith(win);
  expect(mocks.construct).toHaveBeenCalledWith(
    expect.objectContaining({
      icon: '/test/fynvra.png',
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      }),
    })
  );
});
