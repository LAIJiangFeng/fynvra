import { EventEmitter } from 'node:events';
import type { NetworkProxy } from '@shared/networkProxy';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, spawn: mocks.spawn }));

import { configureCommandNetwork } from './commandNetwork';
import { nodeExec } from './orchestration/nodeExec';
import { createShellRunner } from './orchestration/shellRunner';

afterEach(() => configureCommandNetwork(() => undefined));

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
    expect(opts).toMatchObject({
      cwd: '/repo',
      env: { HTTPS_PROXY: config.url, GIT_TERMINAL_PROMPT: '0' },
    });
    expect(opts.shell).toBeUndefined();
    config = undefined;
    await nodeExec('git', ['log'], '/repo');
    expect(mocks.exec.mock.calls.at(-1)?.[2].env).toEqual({
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    });
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
    expect(mocks.spawn).toHaveBeenCalledWith(
      'pnpm typecheck',
      expect.objectContaining({
        cwd: '/repo',
        shell: true,
        env: expect.objectContaining({
          HTTP_PROXY: 'http://127.0.0.1:7890',
          NO_PROXY: '',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        }),
      })
    );
  });
});
