import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>(),
  http: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/fynvra-test-plugins-ipc/userData',
    getVersion: () => '1.0.0',
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw?: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
}));

vi.mock('../services/plugins/marketHttp', () => ({
  createMarketHttpGet: () => mocks.http,
  MarketHttpError: class extends Error {},
}));

vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: vi.fn() }));

const call = (channel: string, raw?: unknown) => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, raw);
};

beforeAll(async () => {
  const { registerPluginHandlers } = await import('./plugins');
  registerPluginHandlers();
});

describe('plugins:readme', () => {
  it('入参收窄：只接受 { id }；未知 id 返回 not-found', async () => {
    for (const raw of [undefined, 'demo', { id: '../x' }, { id: 'demo', path: '/etc' }]) {
      expect(await call(IPC_CHANNELS.PLUGINS_README, raw)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    expect(await call(IPC_CHANNELS.PLUGINS_README, { id: 'missing-plugin' })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });
});

describe('plugins 市场 IPC', () => {
  it('公钥为空时状态为 configured: false，且不发请求', async () => {
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_STATE)).toEqual({
      ok: true,
      state: { configured: false, plugins: [] },
    });
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_REFRESH, { force: true })).toEqual({
      ok: true,
      state: { configured: false, plugins: [] },
    });
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('拒绝多余的键和非法类型', async () => {
    const invalid = expect.objectContaining({ ok: false });
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_STATE, { x: 1 })).toEqual(invalid);
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_REFRESH, { force: 'yes' })).toEqual(invalid);
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_REFRESH, { force: true, url: 'x' })).toEqual(
      invalid
    );
    expect(
      await call(IPC_CHANNELS.PLUGINS_MARKET_INSTALL, {
        pluginId: 'fynvra.demo',
        version: '1.0.0',
        url: 'https://evil.test/x.zip',
      })
    ).toEqual(expect.objectContaining({ ok: false, code: 'invalid' }));
    expect(
      await call(IPC_CHANNELS.PLUGINS_MARKET_INSTALL, { pluginId: 'fynvra.demo', version: 1 })
    ).toEqual(expect.objectContaining({ ok: false, code: 'invalid' }));
    expect(
      await call(IPC_CHANNELS.PLUGINS_MARKET_UPDATE, { id: 'demo', version: '1.0.0' })
    ).toEqual(expect.objectContaining({ ok: false, code: 'invalid' }));
    expect(await call(IPC_CHANNELS.PLUGINS_MARKET_UPDATE, { id: '../x' })).toEqual(
      expect.objectContaining({ ok: false, code: 'invalid' })
    );
    expect(
      await call(IPC_CHANNELS.PLUGINS_MARKET_README, { pluginId: 'fynvra.demo', path: 'x' })
    ).toEqual(invalid);
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('与安装 / 删除共用串行锁；未配置时安装返回可读错误', async () => {
    const install = () =>
      call(IPC_CHANNELS.PLUGINS_MARKET_INSTALL, { pluginId: 'fynvra.demo', version: '1.0.0' });
    // 启动时的待清理目录清理可能还占着锁，占着时返回 busy
    await vi.waitFor(async () => {
      expect(await install()).toEqual(expect.objectContaining({ ok: false, code: 'invalid' }));
    }, 10_000);
  });
});
