import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginConnection } from '../connection';
import { API_METHODS, type ApiDeps } from './index';
import { TELEGRAM_PLUGIN_ID } from './legacy';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-legacy-'));
  path = join(dir, 'telegram.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 走真实的 RPC 检查链，返回插件收到的 res */
function connect(pluginId = TELEGRAM_PLUGIN_ID) {
  const posted: Record<string, unknown>[] = [];
  const connection = createPluginConnection({
    pluginId,
    dataDir: '/data',
    permissions: [],
    methods: API_METHODS,
    deps: { legacyTelegram: { path } } as unknown as ApiDeps,
    post: (message) => posted.push(message as Record<string, unknown>),
  });
  let id = 0;
  async function call(method: string, params?: unknown) {
    const before = posted.length;
    connection.receive({ type: 'req', id: ++id, method, params }, 10);
    await vi.waitFor(() => expect(posted.length).toBe(before + 1));
    return posted.at(-1);
  }
  return { call };
}

describe('legacy.*', () => {
  it('其他插件调用两个方法都被拒，与方法不存在相同', async () => {
    await writeFile(path, '{"token":"secret"}');
    const { call } = connect('fynvra.demo');
    for (const method of ['legacy.telegramData', 'legacy.telegramMigrated']) {
      expect(await call(method)).toMatchObject({
        ok: false,
        error: `method not allowed: ${method}`,
      });
      expect(await call(method, { x: 1 })).toMatchObject({
        error: `method not allowed: ${method}`,
      });
    }
    expect(await readdir(dir)).toEqual(['telegram.json']);
  });

  it('文件不存在返回 null；正常 JSON 原样返回；只接受 undefined 或 {}', async () => {
    const { call } = connect();
    expect(await call('legacy.telegramData')).toMatchObject({ ok: true, result: null });
    const data = { enabled: true, token: '123:abc', groups: [{ id: -1 }] };
    await writeFile(path, JSON.stringify(data));
    expect(await call('legacy.telegramData', {})).toMatchObject({ ok: true, result: data });
    expect(await call('legacy.telegramData', { a: 1 })).toMatchObject({
      ok: false,
      error: 'invalid params: legacy.telegramData',
    });
  });

  it('超过 1 MB 或 JSON 损坏时报错，错误信息不含文件内容', async () => {
    const { call } = connect();
    await writeFile(path, `{"token":"SECRET-TOKEN"`);
    const broken = await call('legacy.telegramData');
    expect(broken).toMatchObject({ ok: false, error: 'legacy data unreadable' });
    expect(JSON.stringify(broken)).not.toContain('SECRET');
    await writeFile(path, JSON.stringify({ token: 'SECRET-TOKEN', pad: 'x'.repeat(1024 * 1024) }));
    const large = await call('legacy.telegramData');
    expect(large).toMatchObject({ ok: false, error: 'legacy data too large' });
    expect(JSON.stringify(large)).not.toContain('SECRET');
  });

  it('telegramMigrated 改名留底；重复调用幂等；之后 telegramData 为 null', async () => {
    await writeFile(path, '{"enabled":true}');
    const { call } = connect();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    expect(await call('legacy.telegramMigrated')).toMatchObject({ ok: true, result: null });
    now.mockRestore();
    expect(await readdir(dir)).toEqual(['telegram.json.migrated-1700000000000']);
    expect(await call('legacy.telegramMigrated', {})).toMatchObject({ ok: true, result: null });
    expect(await readdir(dir)).toEqual(['telegram.json.migrated-1700000000000']);
    expect(await call('legacy.telegramData')).toMatchObject({ ok: true, result: null });
  });
});
