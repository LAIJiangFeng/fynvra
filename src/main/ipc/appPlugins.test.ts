import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createPluginUiStore } from '../services/appPlugins/api/ui';
import { createPluginConnection } from '../services/appPlugins/connection';
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

const uiStore = createPluginUiStore(() => undefined);

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
    uiStore: () => uiStore,
    callPlugin: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
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

  it('ui-get：返回最新描述，没有时为 null；入参收窄', async () => {
    const { call } = setup();
    expect(await call(IPC_CHANNELS.APP_PLUGINS_UI_GET, { id: 'fynvra.other' })).toEqual({
      ok: true,
      ui: null,
    });
    uiStore.set('fynvra.demo', { children: [] });
    expect(await call(IPC_CHANNELS.APP_PLUGINS_UI_GET, { id: 'fynvra.demo' })).toEqual({
      ok: true,
      ui: { children: [] },
    });
    expect(await call(IPC_CHANNELS.APP_PLUGINS_UI_GET, { id: 'fynvra.demo', x: 1 })).toEqual(
      invalid
    );
  });

  it('readme：按登记的 path 读取；非法或未知 id 返回错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fynvra-appreadme-'));
    try {
      await writeFile(join(dir, 'README.md'), '# Demo');
      const { service, call } = setup();
      Object.assign(service, { list: vi.fn(async () => [{ id: 'fynvra.demo', path: dir }]) });
      expect(await call(IPC_CHANNELS.APP_PLUGINS_README, { id: 'fynvra.demo' })).toEqual({
        ok: true,
        text: '# Demo',
      });
      expect(await call(IPC_CHANNELS.APP_PLUGINS_README, { id: 'fynvra.other' })).toMatchObject({
        ok: false,
        code: 'not-found',
      });
      expect(
        await call(IPC_CHANNELS.APP_PLUGINS_README, { id: 'fynvra.demo', path: '/x' })
      ).toMatchObject({ ok: false, code: 'invalid' });
      expect(await call(IPC_CHANNELS.APP_PLUGINS_README, 'fynvra.demo')).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ui-action：入参收窄，转给插件的 ui.action 并带回结果', async () => {
    // 用真实连接：插件收到 call 后按 action 回结果
    const connection = createPluginConnection({
      pluginId: 'fynvra.demo',
      dataDir: '/data',
      permissions: [],
      methods: {},
      deps: {} as never,
      post: (message) => {
        if (message.type !== 'call') return;
        const args = message.args as { action: string };
        const result = args.action === 'bad' ? { ok: false, error: 'token 无效' } : { ok: true };
        queueMicrotask(() =>
          connection.receive({ type: 'ret', id: message.id, ok: true, result }, 10)
        );
      },
    });
    const callPlugin = vi.fn((_id: string, name: string, args: unknown) =>
      connection.call(name, args)
    );
    const { call } = setup({ callPlugin });
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_UI_ACTION, {
        id: 'fynvra.demo',
        action: 'save',
        itemKey: 'chat:1',
        values: { token: 'x', limit: 3, on: true },
      })
    ).toEqual({ ok: true });
    expect(callPlugin).toHaveBeenCalledWith('fynvra.demo', 'ui.action', {
      action: 'save',
      itemKey: 'chat:1',
      values: { token: 'x', limit: 3, on: true },
    });
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_UI_ACTION, { id: 'fynvra.demo', action: 'bad' })
    ).toEqual({ ok: false, error: 'token 无效' });
    expect(callPlugin).toHaveBeenLastCalledWith('fynvra.demo', 'ui.action', {
      action: 'bad',
      values: {},
    });
    for (const raw of [
      { id: 'fynvra.demo', action: 'save', extra: 1 },
      { id: 'fynvra.demo', action: 'a b' },
      { id: 'fynvra.demo', action: 'save', values: { a: [] } },
      { id: 'fynvra.demo', action: 'save', values: 'x' },
    ]) {
      expect(await call(IPC_CHANNELS.APP_PLUGINS_UI_ACTION, raw)).toEqual(invalid);
    }
    expect(callPlugin).toHaveBeenCalledTimes(2);
  });

  it('ui-action：插件超时不回时返回错误', async () => {
    const connection = createPluginConnection({
      pluginId: 'fynvra.demo',
      dataDir: '/data',
      permissions: [],
      methods: {},
      deps: {} as never,
      post: () => undefined,
      timeoutMs: 20,
    });
    const { call } = setup({ callPlugin: (_id, name, args) => connection.call(name, args) });
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_UI_ACTION, { id: 'fynvra.demo', action: 'save' })
    ).toEqual({ ok: false, error: 'call timed out: ui.action' });
  });

  it('open-link 只接受 https', async () => {
    const { deps, call } = setup();
    expect(
      await call(IPC_CHANNELS.APP_PLUGINS_OPEN_LINK, { id: 'fynvra.demo', url: 'https://a.com/x' })
    ).toEqual({ ok: true });
    expect(deps.openExternal).toHaveBeenCalledWith('https://a.com/x');
    for (const url of [
      'http://a.com',
      'file:///C:/Windows',
      'javascript:alert(1)',
      'ms-settings:',
    ]) {
      expect(await call(IPC_CHANNELS.APP_PLUGINS_OPEN_LINK, { id: 'fynvra.demo', url })).toEqual(
        invalid
      );
    }
    expect(deps.openExternal).toHaveBeenCalledTimes(1);
  });
});
