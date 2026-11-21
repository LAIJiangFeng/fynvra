import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginLogger } from '../logger';
import { createAppPluginRegistry } from '../registry';
import { createPluginSecretStore } from '../secrets';
import { API_METHODS, type ApiContext, type ApiDeps } from './index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-app-api-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function secretsStore(register = vi.fn(() => () => undefined)) {
  return {
    register,
    store: createPluginSecretStore({ filePath: join(dir, 'secrets.json'), register }),
  };
}

function context(patch: Partial<ApiDeps> = {}, pluginId = 'fynvra.demo'): ApiContext {
  return {
    pluginId,
    dataDir: join(dir, 'data', pluginId),
    deps: {
      log: vi.fn(),
      secrets: secretsStore().store,
      notify: vi.fn(),
      commandEnv: async () => ({}),
      listWorkspaces: () => [],
      uiStore: { get: () => null, set: () => undefined, clear: () => undefined },
      ...patch,
    },
  };
}

/** 走与 RPC 相同的 parse → run */
async function run(ctx: ApiContext, method: string, params?: unknown) {
  const entry = API_METHODS[method];
  if (!entry) throw new Error(`no method ${method}`);
  const parsed = entry.parse(params);
  if (parsed === null) throw new Error('invalid params');
  return entry.run(ctx, parsed);
}

describe('storage', () => {
  it('原子写入私有数据目录的 storage.json，读回一致；没写过时为 null', async () => {
    const ctx = context();
    expect(await run(ctx, 'storage.read')).toBeNull();
    await run(ctx, 'storage.write', { value: { a: [1, 2] } });
    expect(await run(ctx, 'storage.read')).toEqual({ a: [1, 2] });
    // 原子写不留临时文件
    expect(await readdir(ctx.dataDir)).toEqual(['storage.json']);
  });

  it('超过 5 MB 被拒，旧值不变', async () => {
    const ctx = context();
    await run(ctx, 'storage.write', { value: 'old' });
    await expect(run(ctx, 'storage.write', { value: 'x'.repeat(5 * 1024 * 1024) })).rejects.toThrow(
      '5 MB'
    );
    expect(await run(ctx, 'storage.read')).toBe('old');
  });

  it('入参多余键或缺 value 被拒', () => {
    expect(API_METHODS['storage.write']?.parse({ value: 1, path: '/etc' })).toBeNull();
    expect(API_METHODS['storage.write']?.parse({})).toBeNull();
    expect(API_METHODS['storage.read']?.parse({ path: 'x' })).toBeNull();
  });
});

describe('secrets', () => {
  it('按插件隔离；文件权限 0600；值登记为已知密钥', async () => {
    const { store, register } = secretsStore();
    const a = context({ secrets: store }, 'fynvra.a');
    const b = context({ secrets: store }, 'fynvra.b');
    await run(a, 'secrets.set', { key: 'token', value: 'secret-a-123456' });
    expect(await run(a, 'secrets.get', { key: 'token' })).toBe('secret-a-123456');
    expect(await run(b, 'secrets.get', { key: 'token' })).toBeNull();
    expect(register).toHaveBeenCalledWith('plugin:fynvra.a', expect.any(Function));
    const read = (register.mock.calls[0] as unknown as [string, () => string[]])[1];
    expect(read()).toEqual(['secret-a-123456']);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    }
    await run(a, 'secrets.set', { key: 'token', value: null });
    expect(await run(a, 'secrets.get', { key: 'token' })).toBeNull();
  });

  it('key 不合法或 value 过大被拒', async () => {
    const ctx = context();
    await expect(run(ctx, 'secrets.set', { key: '../x', value: 'v' })).rejects.toThrow('key');
    await expect(run(ctx, 'secrets.set', { key: 'k'.repeat(65), value: 'v' })).rejects.toThrow();
    await expect(run(ctx, 'secrets.set', { key: 'k', value: 'v'.repeat(4097) })).rejects.toThrow(
      'too large'
    );
    expect(API_METHODS['secrets.set']?.parse({ key: 'k', value: 1 })).toBeNull();
  });

  it('删除插件时连带清掉并注销已知密钥', async () => {
    const unregister = vi.fn();
    const { store } = secretsStore(vi.fn(() => unregister));
    await store.set('fynvra.a', 'k', 'value-a');
    await store.set('fynvra.b', 'k', 'value-b');
    await store.removePlugin('fynvra.a');
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(await store.get('fynvra.a', 'k')).toBeNull();
    expect(await store.get('fynvra.b', 'k')).toBe('value-b');
    const saved = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    expect(Object.keys(saved.plugins)).toEqual(['fynvra.b']);
  });
});

describe('log', () => {
  it('每秒最多 100 行，下一秒补一行丢弃条数；抹掉本插件密钥', () => {
    const sink = vi.fn();
    let clock = 1000;
    const logger = createPluginLogger({
      secrets: (id) => (id === 'fynvra.a' ? ['hunter2-secret'] : []),
      sink,
      now: () => clock,
    });
    logger.write('fynvra.a', 'info', 'token=hunter2-secret');
    expect(sink).toHaveBeenLastCalledWith('info', '[plugin:fynvra.a] token=***');
    logger.write('fynvra.a', 'info', Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n'));
    expect(sink).toHaveBeenCalledTimes(100);
    // 另一个插件不受影响
    logger.write('fynvra.b', 'warn', 'hello');
    expect(sink).toHaveBeenCalledTimes(101);
    clock += 1000;
    logger.write('fynvra.a', 'info', 'next');
    expect(sink).toHaveBeenCalledWith(
      'warn',
      '[plugin:fynvra.a] dropped 51 log lines (rate limit)'
    );
    expect(sink).toHaveBeenLastCalledWith('info', '[plugin:fynvra.a] next');
  });

  it('log 方法把 level / message 交给 deps.log', async () => {
    const log = vi.fn();
    await run(context({ log }), 'log', { level: 'warn', message: 'hi' });
    expect(log).toHaveBeenCalledWith('fynvra.demo', 'warn', 'hi');
    expect(API_METHODS.log?.parse({ level: 'fatal', message: 'x' })).toBeNull();
  });
});

describe('notify / net / workspaces', () => {
  it('notify 要求 notifications 权限并转交', async () => {
    expect(API_METHODS.notify?.permission).toBe('notifications');
    const notify = vi.fn();
    await run(context({ notify }), 'notify', { title: 't', body: 'b' });
    expect(notify).toHaveBeenCalledWith('t', 'b');
  });

  it('net.proxyEnv 要求 network 权限，只返回三个代理键', async () => {
    expect(API_METHODS['net.proxyEnv']?.permission).toBe('network');
    const result = await run(
      context({
        commandEnv: async () => ({
          HTTP_PROXY: 'http://p:1',
          https_proxy: 'http://p:2',
          NO_PROXY: 'localhost',
          OPENAI_API_KEY: 'sk-xxx',
          PATH: '/bin',
        }),
      }),
      'net.proxyEnv'
    );
    expect(result).toEqual({
      HTTP_PROXY: 'http://p:1',
      HTTPS_PROXY: 'http://p:2',
      NO_PROXY: 'localhost',
    });
  });

  it('workspaces.list 要求 workspaces 权限，返回里没有路径', async () => {
    expect(API_METHODS['workspaces.list']?.permission).toBe('workspaces');
    const result = await run(
      context({
        listWorkspaces: () => [
          { id: 'w1', name: 'Repo', vcs: 'git', repoPath: 'C:/secret/repo' } as never,
          { id: 'w2', name: 'Dir', vcs: 'none' },
        ],
      }),
      'workspaces.list'
    );
    expect(result).toEqual([
      { id: 'w1', name: 'Repo', git: true },
      { id: 'w2', name: 'Dir', git: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('登记', () => {
  it('原子写；损坏时改名留底按空登记继续', async () => {
    const filePath = join(dir, 'fynvra-plugins.json');
    await writeFile(filePath, '{oops');
    const registry = createAppPluginRegistry({ filePath, now: () => 42 });
    expect(await registry.list()).toEqual([]);
    expect(await readdir(dir)).toContain('fynvra-plugins.json.corrupt-42');
    await registry.add({
      id: 'fynvra.demo',
      name: 'Demo',
      version: '1.0.0',
      source: 'local',
      path: '/x',
      enabled: true,
      permissions: ['network'],
    });
    await registry.update('fynvra.demo', { lastError: 'boom' });
    await registry.update('fynvra.demo', { lastError: undefined });
    const fresh = createAppPluginRegistry({ filePath });
    expect(await fresh.get('fynvra.demo')).toMatchObject({ version: '1.0.0', enabled: true });
    expect((await fresh.get('fynvra.demo'))?.lastError).toBeUndefined();
  });
});
