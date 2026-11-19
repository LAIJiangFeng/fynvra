import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { NetworkProxy } from '@shared/networkProxy';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, spawn: mocks.spawn }));

import {
  configureCommandNetwork,
  freshCommandEnvironment,
  savedCommandEnvironment,
  savedNetworkProxy,
} from './commandNetwork';
import { nodeExec } from './orchestration/nodeExec';
import { createShellRunner } from './orchestration/shellRunner';
import { createSystemProxyResolver, setSystemProxy } from './systemProxy';

afterEach(() => {
  configureCommandNetwork(() => undefined);
  setSystemProxy(null);
});

// 只挑出相关键再断言，避免失败时 vitest 打印整份环境变量（可能含真实 token）
const pick = (env: NodeJS.ProcessEnv | undefined, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, env?.[key]]));

describe('Main command proxy wiring', () => {
  it('默认跟随系统代理：用解析出的地址，spec 也带上它；显式保存的模式不受影响', async () => {
    let time = 0;
    let raw = 'PROXY 127.0.0.1:7890; DIRECT';
    const resolver = createSystemProxyResolver({ resolve: async () => raw, now: () => time });
    setSystemProxy(resolver);
    const keys = ['HTTPS_PROXY', 'NO_PROXY'];
    // 解析前为未知：继承原环境
    expect(pick(savedCommandEnvironment(), keys)).toEqual(pick(process.env, keys));
    await resolver.fresh();
    expect(savedNetworkProxy()).toEqual({
      mode: 'system',
      url: 'http://127.0.0.1:7890',
      gitCompatibility: false,
    });
    expect(pick(savedCommandEnvironment(), keys)).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    mocks.exec.mockImplementation((_cmd, _args, _options, callback) => callback(null, 'ok', ''));
    await nodeExec('gh', ['pr', 'create'], '/repo');
    expect(pick(mocks.exec.mock.calls.at(-1)?.[2].env, ['HTTPS_PROXY'])).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
    // Telegram 请求前：缓存超过 5 秒先刷新
    raw = 'DIRECT';
    time = 6_000;
    expect(pick(await freshCommandEnvironment(), keys)).toEqual(pick(process.env, keys));
    configureCommandNetwork(() => ({ mode: 'environment', gitCompatibility: false }));
    expect(savedNetworkProxy()).toEqual({ mode: 'environment', gitCompatibility: false });
  });

  it('Git reads saved configuration on every command without changing argv/global env', async () => {
    let config: NetworkProxy | undefined = {
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
      gitCompatibility: true,
    };
    configureCommandNetwork(() => config);
    mocks.exec.mockImplementation((_cmd, _args, _options, callback) => callback(null, 'ok', ''));
    await nodeExec('git', ['status'], '/repo');
    const [cmd, args, opts] = mocks.exec.mock.calls.at(-1) ?? [];
    expect([cmd, args]).toEqual(['git', ['status']]);
    expect(opts.cwd).toBe('/repo');
    expect(pick(opts.env, ['HTTPS_PROXY', 'GIT_TERMINAL_PROMPT'])).toEqual({
      HTTPS_PROXY: config.url,
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(opts.shell).toBeUndefined();
    config = undefined;
    await nodeExec('git', ['log'], '/repo');
    const env = mocks.exec.mock.calls.at(-1)?.[2].env;
    const keys = ['GIT_TERMINAL_PROMPT', 'GH_PROMPT_DISABLED', 'HTTPS_PROXY'];
    expect(pick(env, keys)).toEqual(
      pick({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, keys)
    );
    // 完整比较只输出布尔值，失败时不泄露环境变量
    const expected = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
    expect(isDeepStrictEqual(env, expected)).toBe(true);
  });
  it('run_checks spawns its existing shell with the same environment and output controls', async () => {
    configureCommandNetwork(() => ({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
      gitCompatibility: true,
    }));
    const stream = () =>
      Object.assign(new EventEmitter(), {
        setEncoding() {
          return this;
        },
      });
    const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream() });
    mocks.spawn.mockReturnValue(child);
    const pending = createShellRunner()('/repo', 'pnpm typecheck');
    child.emit('close', 0);
    expect((await pending).exitCode).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, opts] = mocks.spawn.mock.calls[0];
    expect(cmd).toBe('pnpm typecheck');
    expect(opts.cwd).toBe('/repo');
    expect(opts.shell).toBe(true);
    expect(pick(opts.env, ['HTTP_PROXY', 'NO_PROXY', 'NO_COLOR', 'FORCE_COLOR'])).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });
});
