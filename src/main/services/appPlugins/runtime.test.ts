import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppPluginRegistry } from './registry';
import { createAppPluginRuntime, pickPluginEnv } from './runtime';
import { createPluginSecretStore } from './secrets';
import { createAppPluginService } from './service';
import { createFakeFork } from './testing';

const ID = 'fynvra.demo';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-app-runtime-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** 手动推进的定时器 */
function fakeTimers() {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      if (handle) (handle as { cleared: boolean }).cleared = true;
    },
    /** 触发最后一个未清除的定时器 */
    fireLast: () => {
      const timer = timers.filter((item) => !item.cleared).at(-1);
      if (!timer) throw new Error('no timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

async function setup(options: { enabled?: boolean; autoActivate?: boolean } = {}) {
  const registry = createAppPluginRegistry({ filePath: join(dir, 'fynvra-plugins.json') });
  const root = join(dir, 'fynvra-plugins');
  const path = join(root, ID);
  await mkdir(path, { recursive: true });
  await registry.add({
    id: ID,
    name: 'Demo',
    version: '1.0.0',
    source: 'market',
    path,
    enabled: options.enabled ?? true,
    permissions: [],
  });
  const { fork, processes } = createFakeFork({ autoActivate: options.autoActivate });
  const timers = fakeTimers();
  let clock = 1_000_000;
  const onChanged = vi.fn();
  const log = vi.fn();
  const secrets = createPluginSecretStore({
    filePath: join(dir, 'secrets.json'),
    register: () => () => undefined,
  });
  const runtime = createAppPluginRuntime({
    registry,
    fork,
    apiDeps: {
      log,
      secrets,
      notify: vi.fn(),
      commandEnv: async () => ({}),
      listWorkspaces: () => [],
    },
    dataRoot: join(dir, 'data'),
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    entryPathOf: (record, main) => join(record.path, main),
    readMain: async () => 'dist/host.js',
    onChanged,
    env: { PATH: '/bin', Path2: 'x', OPENAI_API_KEY: 'sk-1', HTTPS_PROXY: 'http://p', TEMP: '/t' },
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const service = createAppPluginService({
    registry,
    runtime,
    secrets,
    root: () => root,
    dataRoot: join(dir, 'data'),
    onChanged,
  });
  return {
    registry,
    runtime,
    service,
    secrets,
    processes,
    timers,
    onChanged,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('生命周期', () => {
  it('启动：只给白名单环境变量，cwd 为私有数据目录，收到 activated 后为 running', async () => {
    const t = await setup({ autoActivate: false });
    await t.runtime.startAll();
    expect(t.processes).toHaveLength(1);
    const child = t.processes[0];
    expect(child?.options.env).toEqual({ PATH: '/bin', TEMP: '/t' });
    expect(child?.options.cwd).toBe(join(dir, 'data', ID));
    expect(child?.sent[0]).toEqual({
      type: 'init',
      pluginId: ID,
      entryPath: join(dir, 'fynvra-plugins', ID, 'dist/host.js'),
      dataDir: join(dir, 'data', ID),
    });
    expect(t.runtime.status(ID)).toBe('starting');
    child?.emit({ type: 'activated' });
    expect(t.runtime.status(ID)).toBe('running');
    expect(t.onChanged).toHaveBeenCalled();
  });

  it('未启用的不启动；启用立即启动，停用发 deactivate 并在退出后为 stopped', async () => {
    const t = await setup({ enabled: false });
    await t.runtime.startAll();
    expect(t.processes).toHaveLength(0);
    await t.service.toggle(ID, true);
    expect(t.processes).toHaveLength(1);
    const result = await t.service.toggle(ID, false);
    expect(t.processes[0]?.sent.at(-1)).toEqual({ type: 'deactivate' });
    expect(t.processes[0]?.killed).toBe(false);
    expect(result).toMatchObject({ ok: true, plugin: { enabled: false, status: 'stopped' } });
  });

  it('崩溃后按 2 秒起翻倍退避重启', async () => {
    const t = await setup();
    await t.runtime.startAll();
    t.processes[0]?.exit(1);
    await vi.waitFor(() => expect(t.timers.timers).toHaveLength(1));
    expect(t.runtime.status(ID)).toBe('crashed');
    expect(t.timers.timers[0]?.ms).toBe(2000);
    expect((await t.registry.get(ID))?.lastError).toContain('code 1');
    t.timers.fireLast();
    await vi.waitFor(() => expect(t.processes).toHaveLength(2));
    t.advance(11 * 60 * 1000);
    t.processes[1]?.exit(1);
    await vi.waitFor(() => expect(t.timers.timers).toHaveLength(2));
    expect(t.timers.timers[1]?.ms).toBe(4000);
  });

  it('10 分钟内崩溃 3 次：自动停用并写入 lastError，不再重启', async () => {
    const t = await setup();
    await t.runtime.startAll();
    for (let i = 0; i < 2; i++) {
      t.processes[i]?.exit(1);
      await vi.waitFor(() => expect(t.timers.timers).toHaveLength(i + 1));
      t.advance(60_000);
      t.timers.fireLast();
      await vi.waitFor(() => expect(t.processes).toHaveLength(i + 2));
    }
    // activate 抛错同样算崩溃，原因取插件报的错误
    t.processes[2]?.emit({ type: 'activate-failed', error: 'bad token' });
    t.processes[2]?.exit(1);
    await vi.waitFor(async () => expect((await t.registry.get(ID))?.enabled).toBe(false));
    const record = await t.registry.get(ID);
    expect(record?.lastError).toContain('bad token');
    expect(record?.lastError).toContain('3 crashes');
    expect(t.timers.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    expect(t.runtime.status(ID)).toBe('crashed');
    // 手动重新启用：清掉错误和计数
    await t.service.toggle(ID, true);
    expect((await t.registry.get(ID))?.lastError).toBeUndefined();
    expect(t.processes).toHaveLength(4);
  });

  it('退出时先 deactivate，5 秒内不退出就强杀', async () => {
    const t = await setup();
    await t.runtime.startAll();
    const child = t.processes[0];
    if (!child) throw new Error('no process');
    child.exitOnDeactivate = false;
    const done = t.runtime.shutdown();
    await vi.waitFor(() => expect(t.timers.timers.some((timer) => timer.ms === 5000)).toBe(true));
    expect(child.sent.at(-1)).toEqual({ type: 'deactivate' });
    expect(child.killed).toBe(false);
    t.timers.fireLast();
    await done;
    expect(child.killed).toBe(true);
    // 退出途中的退出事件不算崩溃
    expect(t.timers.timers.filter((timer) => timer.ms === 2000)).toHaveLength(0);
  });

  it('stdout / stderr 进日志', async () => {
    const t = await setup();
    await t.runtime.startAll();
    t.processes[0]?.output('stderr', 'oops');
    expect(t.log).toHaveBeenCalledWith(ID, 'warn', 'oops');
  });
});

describe('移除', () => {
  it('先停进程，再删包目录、私有数据、密钥与登记', async () => {
    const t = await setup();
    await t.runtime.startAll();
    await writeFile(join(dir, 'fynvra-plugins', ID, 'x.js'), '');
    await mkdir(join(dir, 'data', ID), { recursive: true });
    await t.secrets.set(ID, 'token', 'value-123');
    await t.secrets.set('fynvra.other', 'token', 'keep');
    expect(await t.service.remove(ID)).toEqual({ ok: true });
    expect(t.processes[0]?.sent.at(-1)).toEqual({ type: 'deactivate' });
    expect(await readdir(join(dir, 'fynvra-plugins'))).toEqual([]);
    expect(await readdir(join(dir, 'data'))).toEqual([]);
    expect(await t.secrets.get(ID, 'token')).toBeNull();
    expect(await t.secrets.get('fynvra.other', 'token')).toBe('keep');
    expect(await t.registry.list()).toEqual([]);
  });
});

describe('pickPluginEnv', () => {
  it('Windows 风格大小写也能取到，其他一律不带', () => {
    expect(pickPluginEnv({ Path: 'C:/bin', SYSTEMROOT: 'C:/Windows', GITHUB_TOKEN: 'x' })).toEqual({
      PATH: 'C:/bin',
      SystemRoot: 'C:/Windows',
    });
  });
});
