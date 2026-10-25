import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBoxSync: mocks.confirm } }));

import { registerFileUnloadGuard } from './fileUnloadGuard';

describe('未保存文件的原生退出确认', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([0, 1])('默认取消，仅明确放弃时允许退出：%s', (choice) => {
    let handler!: (event: { preventDefault(): void }) => void;
    const win = {
      webContents: {
        on: (_event: string, callback: typeof handler) => {
          handler = callback;
        },
      },
    };
    registerFileUnloadGuard(win as unknown as BrowserWindow);
    mocks.confirm.mockReturnValue(choice);
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(mocks.confirm).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ defaultId: 0, cancelId: 0 })
    );
    expect(event.preventDefault).toHaveBeenCalledTimes(choice === 1 ? 1 : 0);
  });
});
