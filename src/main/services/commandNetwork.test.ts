import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { NetworkProxy } from '@shared/networkProxy';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, spawn: mocks.spawn }));

import { configureCommandNetwork } from './commandNetwork';
import { nodeExec } from './orchestration/nodeExec';
import { createShellRunner } from './orchestration/shellRunner';

afterEach(() => configureCommandNetwork(() => undefined));

// 只挑出相关键再断言，避免失败时 vitest 打印整份环境变量（可能含真实 token）
const pick = (env: NodeJS.ProcessEnv | undefined, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, env?.[key]]));

describe('Main command proxy wiring', () => {
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
