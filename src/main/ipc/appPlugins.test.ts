import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import type { AppPluginService } from '../services/appPlugins/service';
import { type AppPluginHandlerDeps, createAppPluginHandlers } from './appPlugins';

vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: vi.fn() }));

const view = {
  id: 'fynvra.demo',
  name: 'Demo',
  version: '1.0.0',
  tier: 'official' as const,
  source: 'market' as const,
  enabled: true,
  status: 'running' as const,
  permissions: [],
};

function setup(patch: Partial<AppPluginHandlerDeps> = {}) {
  const service = {
    views: vi.fn(async () => [view]),
    toggle: vi.fn(async () => ({ ok: true as const, plugin: view })),
    remove: vi.fn(async () => ({ ok: true as const })),
    addLocal: vi.fn(async () => ({ ok: true as const, plugin: view })),
    recopy: vi.fn(async () => ({ ok: true as const, plugin: view })),
  };
  const deps: AppPluginHandlerDeps = {
    service: () => service as unknown as AppPluginService,
    updateViaMarket: vi.fn(async () => ({ ok: true as const, plugin: view })),
    isPackaged: () => false,
    pickDirectory: vi.fn(async () => '/src/plugin'),
    exclusive: (_onBusy, task) => task(),
    ...patch,
  };
  const handlers = createAppPluginHandlers(deps);
  const call = (channel: string, raw?: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({} as Electron.WebContents, raw);
  };
  return { service, deps, call };
}

const invalid = expect.objectContaining({ ok: false });

describe('appPlugins IPC', () => {
  it('六个通道都有 handler', () => {
    const { call } = setup();
    for (const channel of [
      IPC_CHANNELS.APP_PLUGINS_LIST,
      IPC_CHANNELS.APP_PLUGINS_TOGGLE,
      IPC_CHANNELS.APP_PLUGINS_REMOVE,
      IPC_CHANNELS.APP_PLUGINS_UPDATE,
      IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV,
      IPC_CHANNELS.APP_PLUGINS_RECOPY,
    ]) {
      expect(() => call(channel, { bogus: 1 })).not.toThrow();
    }
  });

  it('入参收窄：合法入参转交 id，多余键与非法 id 被拒', async () => {
    const { service, deps, call } = setup();
    expect(await call(IPC_CHANNELS.APP_PLUGINS_LIST)).toEqual({ ok: true, plugins: [view] });
    expect(await call(IPC_CHANNELS.APP_PLUGINS_LIST, { x: 1 })).toEqual(invalid);
    await call(IPC_CHANNELS.APP_PLUGINS_TOGGLE, { id: 'fynvra.demo', enabled: false });
    expect(service.toggle).toHaveBeenCalledWith('fynvra.demo', false);
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_TOGGLE, { id: 'fynvra.demo', enabled: 'no' })
    ).toEqual(invalid);
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_TOGGLE, { id: 'fynvra.demo', enabled: true, path: '/x' })
    ).toEqual(invalid);
    expect(await call(IPC_CHANNELS.APP_PLUGINS_REMOVE, { id: '../etc' })).toEqual(invalid);
    expect(await call(IPC_CHANNELS.APP_PLUGINS_REMOVE, 'fynvra.demo')).toEqual(invalid);
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_UPDATE, { id: 'fynvra.demo', version: '2' })
    ).toEqual(invalid);
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_RECOPY, { id: 'fynvra.demo', source: '/x' })
    ).toEqual(invalid);
    expect(await call(IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV, { path: '/x' })).toEqual(invalid);
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.recopy).not.toHaveBeenCalled();
    expect(deps.updateViaMarket).not.toHaveBeenCalled();
    await call(IPC_CHANNELS.APP_PLUGINS_REMOVE, { id: 'fynvra.demo' });
    expect(service.remove).toHaveBeenCalledWith('fynvra.demo');
    await call(IPC_CHANNELS.APP_PLUGINS_UPDATE, { id: 'fynvra.demo' });
    expect(deps.updateViaMarket).toHaveBeenCalledWith('fynvra.demo');
  });

  it('开发版：add-local-dev 弹框后安装；取消返回 canceled', async () => {
    const { service, call } = setup();
    expect(await call(IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV)).toMatchObject({ ok: true });
    expect(service.addLocal).toHaveBeenCalledWith('/src/plugin');
    const canceled = setup({ pickDirectory: async () => null });
    expect(await canceled.call(IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV, {})).toMatchObject({
      ok: false,
      code: 'canceled',
    });
  });

  it('正式版调 add-local-dev 被拒，不弹框', async () => {
    const pickDirectory = vi.fn(async () => '/x');
    const { service, call } = setup({ isPackaged: () => true, pickDirectory });
    expect(await call(IPC_CHANNELS.APP_PLUGINS_ADD_LOCAL_DEV)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(service.addLocal).not.toHaveBeenCalled();
  });

  it('删除 / 更新 / 复制走串行锁，忙时返回 busy', async () => {
    const { service, call } = setup({ exclusive: (onBusy) => Promise.resolve(onBusy()) });
    expect(await call(IPC_CHANNELS.APP_PLUGINS_REMOVE, { id: 'fynvra.demo' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    expect(service.remove).not.toHaveBeenCalled();
  });
});
