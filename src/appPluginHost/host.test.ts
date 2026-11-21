import type { FynvraPluginApi } from '@shared/types/appPluginApi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HostPort, startPluginHost } from './host';

/** 假 parentPort：sent 是宿主发给 Main 的消息，deliver 模拟 Main 发来的消息 */
function fakePort() {
  const sent: Record<string, unknown>[] = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  const port: HostPort = {
    on: (_event, callback) => {
      listener = callback;
    },
    postMessage: (message) => sent.push(message as Record<string, unknown>),
  };
  return { port, sent, deliver: (data: unknown) => listener?.({ data }) };
}

function boot(module: Record<string, unknown>, timeoutMs = 1000) {
  const { port, sent, deliver } = fakePort();
  const exit = vi.fn();
  const importModule = vi.fn(async (_url: string) => module);
  startPluginHost({ port, importModule, exit, timeoutMs });
  deliver({
    type: 'init',
    pluginId: 'fynvra.demo',
    entryPath: '/plugins/demo/host.js',
    dataDir: '/d',
  });
  return { sent, deliver, exit, importModule };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('插件宿主', () => {
  it('init 后加载入口并调用 activate(api)，回 activated', async () => {
    let api: FynvraPluginApi | undefined;
    const { sent, importModule } = boot({ activate: (value: FynvraPluginApi) => (api = value) });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'activated' }));
    expect(importModule.mock.calls[0]?.[0]).toMatch(/^file:\/\/.*host\.js$/);
    expect(api?.pluginId).toBe('fynvra.demo');
    expect(api?.dataDir).toBe('/d');
  });

  it('activate 抛错：回 activate-failed 并以非 0 退出', async () => {
    const { sent, exit } = boot({
      activate: () => {
        throw new Error('bad config');
      },
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(sent).toContainEqual({ type: 'activate-failed', error: 'bad config' });
  });

  it('req / res：插件调宿主拿到结果或错误', async () => {
    let api: FynvraPluginApi | undefined;
    const { sent, deliver } = boot({ activate: (value: FynvraPluginApi) => (api = value) });
    await vi.waitFor(() => expect(api).toBeDefined());
    const got = api?.secrets.get('token');
    const req = sent.at(-1);
    expect(req).toMatchObject({ type: 'req', method: 'secrets.get', params: { key: 'token' } });
    deliver({ type: 'res', id: req?.id, ok: true, result: 'v' });
    await expect(got).resolves.toBe('v');
    const denied = api?.notify({ title: 't', body: 'b' });
    deliver({ type: 'res', id: sent.at(-1)?.id, ok: false, error: 'permission required' });
    await expect(denied).rejects.toThrow('permission required');
  });

  it('api.legacy.* 发出对应的 req', async () => {
    let api: FynvraPluginApi | undefined;
    const { sent, deliver } = boot({ activate: (value: FynvraPluginApi) => (api = value) });
    await vi.waitFor(() => expect(api).toBeDefined());
    const data = api?.legacy.telegramData();
    expect(sent.at(-1)).toMatchObject({ type: 'req', method: 'legacy.telegramData' });
    deliver({ type: 'res', id: sent.at(-1)?.id, ok: true, result: { token: 't' } });
    await expect(data).resolves.toEqual({ token: 't' });
    const migrated = api?.legacy.telegramMigrated();
    expect(sent.at(-1)).toMatchObject({ type: 'req', method: 'legacy.telegramMigrated' });
    deliver({ type: 'res', id: sent.at(-1)?.id, ok: true, result: null });
    await expect(migrated).resolves.toBeUndefined();
  });

  it('req 超时', async () => {
    vi.useFakeTimers();
    let api: FynvraPluginApi | undefined;
    boot({ activate: (value: FynvraPluginApi) => (api = value) }, 500);
    await vi.waitFor(() => expect(api).toBeDefined());
    const pending = api?.workspaces.list();
    vi.advanceTimersByTime(501);
    await expect(pending).rejects.toThrow('timed out');
  });

  it('evt 分发给订阅者；取消订阅后不再收到', async () => {
    const handler = vi.fn();
    let off: (() => void) | undefined;
    const { sent, deliver } = boot({
      activate: (api: FynvraPluginApi) => {
        off = api.on('channel.session', handler);
      },
    });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'activated' }));
    deliver({ type: 'evt', event: 'channel.session', payload: { id: 1 } });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
    off?.();
    deliver({ type: 'evt', event: 'channel.session', payload: { id: 2 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('call / ret：已注册返回结果；抛错只回 message；未注册回错误', async () => {
    const { sent, deliver } = boot({
      activate: (api: FynvraPluginApi) => {
        api.handle('ui.action', (args) => ({ echo: args }));
        api.handle('fail', () => {
          throw new Error('nope');
        });
      },
    });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'activated' }));
    deliver({ type: 'call', id: 1, name: 'ui.action', args: 5 });
    deliver({ type: 'call', id: 2, name: 'fail', args: null });
    deliver({ type: 'call', id: 3, name: 'missing', args: null });
    await vi.waitFor(() => expect(sent.filter((item) => item.type === 'ret')).toHaveLength(3));
    expect(sent).toContainEqual({ type: 'ret', id: 1, ok: true, result: { echo: 5 } });
    expect(sent).toContainEqual({ type: 'ret', id: 2, ok: false, error: 'nope' });
    expect(sent).toContainEqual({ type: 'ret', id: 3, ok: false, error: 'no handler: missing' });
  });

  it('deactivate：先调插件的 deactivate 再退出', async () => {
    const deactivate = vi.fn();
    const { sent, deliver, exit } = boot({ activate: () => undefined, deactivate });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'activated' }));
    deliver({ type: 'deactivate' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(deactivate).toHaveBeenCalledTimes(1);
  });
});
