import type { HostInboundMessage } from '@shared/types/appPlugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiDeps, defineMethod } from './api';
import { createPluginConnection, messageSize } from './connection';

const methods = {
  echo: defineMethod({
    parse: (raw) => (typeof raw === 'string' ? raw : null),
    run: (_ctx, value: string) => value,
  }),
  secret: defineMethod({
    permission: 'notifications',
    parse: () => ({}),
    run: () => 'ok',
  }),
  boom: defineMethod({
    parse: () => ({}),
    run: () => {
      throw new Error('kaput');
    },
  }),
};

function setup(permissions: ('notifications' | 'network')[] = []) {
  const sent: HostInboundMessage[] = [];
  const connection = createPluginConnection({
    pluginId: 'fynvra.demo',
    dataDir: '/tmp/x',
    permissions,
    methods,
    deps: {} as ApiDeps,
    post: (message) => sent.push(message),
    timeoutMs: 1000,
  });
  /** 内存里对接：模拟插件发 req */
  const request = async (method: string, params?: unknown) => {
    const message = { type: 'req' as const, id: sent.length + 100, method, params };
    connection.receive(message, messageSize(message));
    await vi.waitFor(() =>
      expect(sent.some((item) => 'id' in item && item.id === message.id)).toBe(true)
    );
    return sent.find((item) => 'id' in item && item.id === message.id);
  };
  return { sent, connection, request };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RPC 分发', () => {
  it('白名单内的方法正常返回', async () => {
    expect(await setup().request('echo', 'hi')).toMatchObject({ ok: true, result: 'hi' });
  });

  it('不在白名单（含原型链上的名字）被拒', async () => {
    const { request } = setup();
    expect(await request('fs.read')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not allowed'),
    });
    expect(await request('toString')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not allowed'),
    });
  });

  it('缺少权限被拒，有权限通过', async () => {
    expect(await setup().request('secret')).toMatchObject({
      ok: false,
      error: 'permission required: notifications',
    });
    expect(await setup(['notifications']).request('secret')).toMatchObject({ ok: true });
  });

  it('入参非法被拒', async () => {
    expect(await setup().request('echo', 42)).toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid params'),
    });
  });

  it('超过 1 MB 被拒', async () => {
    expect(await setup().request('echo', 'x'.repeat(1024 * 1024 + 1))).toMatchObject({
      ok: false,
      error: expect.stringContaining('1 MB'),
    });
  });

  it('处理函数抛错只回 message', async () => {
    expect(await setup().request('boom')).toEqual({
      type: 'res',
      id: expect.any(Number),
      ok: false,
      error: 'kaput',
    });
  });

  it('宿主调插件：ret 解析结果；对方没注册时 reject', async () => {
    const { sent, connection } = setup();
    const done = connection.call('ui.action', { a: 1 });
    const call = sent.at(-1) as { id: number };
    expect(sent.at(-1)).toMatchObject({ type: 'call', name: 'ui.action', args: { a: 1 } });
    connection.receive({ type: 'ret', id: call.id, ok: true, result: 7 }, 10);
    await expect(done).resolves.toBe(7);
    const missing = connection.call('nobody', null);
    const id = (sent.at(-1) as { id: number }).id;
    connection.receive({ type: 'ret', id, ok: false, error: 'no handler: nobody' }, 10);
    await expect(missing).rejects.toThrow('no handler: nobody');
  });

  it('宿主调插件超时', async () => {
    vi.useFakeTimers();
    const { connection } = setup();
    const pending = connection.call('slow', null);
    vi.advanceTimersByTime(1001);
    await expect(pending).rejects.toThrow('timed out');
  });

  it('进程退出时未完成的调用立即失败', async () => {
    const { connection } = setup();
    const pending = connection.call('x', null);
    connection.close('plugin process exited');
    await expect(pending).rejects.toThrow('exited');
    await expect(connection.call('y', null)).rejects.toThrow('not running');
  });
});
