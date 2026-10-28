import { EventEmitter } from 'node:events';
import { DEFAULT_NETWORK_PROXY } from '@shared/networkProxy';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  agent: vi.fn(),
  spawn: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('node:https', () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.agent(options);
    }
    destroy = mocks.destroy;
  },
  get: mocks.get,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { testCommandNetwork } from './networkTest';

function childResult(output = 'abcdef1234\tHEAD\n', error = false) {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding() {
      return this;
    },
  });
  const child = Object.assign(new EventEmitter(), { stdout });
  queueMicrotask(() => {
    if (error) child.emit('error', { code: 'ENOENT', message: 'secret' });
    else {
      stdout.emit('data', output);
      child.emit('close', 0);
    }
  });
  return child;
}

const nodeVersion = process.versions.node;
beforeAll(() =>
  Object.defineProperty(process.versions, 'node', { value: '24.5.0', configurable: true })
);
afterAll(() =>
  Object.defineProperty(process.versions, 'node', { value: nodeVersion, configurable: true })
);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((_url, _options, callback) => {
    callback({ statusCode: 200, destroy: vi.fn() });
    return new EventEmitter();
  });
  mocks.spawn.mockImplementation(() => childResult());
});

describe('fixed network probe transports', () => {
  it('uses a private proxy agent with TLS and a noninteractive readonly Git argv', async () => {
    const result = await testCommandNetwork(
      { mode: 'manual', url: 'https://proxy.example:7890', gitCompatibility: true },
      new AbortController().signal,
      { env: { NO_PROXY: '*' } }
    );
    expect(result).toEqual({ api: { status: 'ok', httpStatus: 200 }, git: { status: 'ok' } });
    expect(mocks.agent).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectUnauthorized: true,
        proxyEnv: expect.objectContaining({
          HTTPS_PROXY: 'https://proxy.example:7890',
          NO_PROXY: '',
        }),
      })
    );
    expect(mocks.get.mock.calls[0]?.[0]).toBe('https://api.github.com/');
    expect(mocks.get.mock.calls[0]?.[1]).toMatchObject({ rejectUnauthorized: true });
    const [cmd, args, options] = mocks.spawn.mock.calls[0] ?? [];
    expect(cmd).toBe('git');
    expect(args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      '-c',
      'credential.interactive=false',
      '-c',
      'http.sslVerify=true',
      '-c',
      'http.proxySSLVerify=true',
      'ls-remote',
      '--exit-code',
      'https://github.com/LAIJiangFeng/fynvra.git',
      'HEAD',
    ]);
    expect(options.shell).toBeUndefined();
    expect(options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_COUNT: '3',
    });
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it('never returns process stderr or proxy errors; missing Git is distinct', async () => {
    mocks.get.mockImplementation(() => {
      throw new Error('https://secret@proxy');
    });
    mocks.spawn.mockImplementation(() => childResult('', true));
    expect(
      await testCommandNetwork(DEFAULT_NETWORK_PROXY, new AbortController().signal, { env: {} })
    ).toEqual({ api: { status: 'failed' }, git: { status: 'unavailable' } });
  });
  it('cancels the owned Git process tree', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding() {
          return this;
        },
      });
      const child = Object.assign(new EventEmitter(), { pid: 123456789, stdout, kill: vi.fn() });
      mocks.spawn.mockImplementation((cmd) => (cmd === 'git' ? child : new EventEmitter()));
      const controller = new AbortController();
      const pending = testCommandNetwork(DEFAULT_NETWORK_PROXY, controller.signal, { env: {} });
      controller.abort();
      expect((await pending).git.status).toBe('canceled');
      if (process.platform === 'win32')
        expect(mocks.spawn).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', '123456789', '/T', '/F'],
          expect.anything()
        );
      else expect(kill).toHaveBeenCalledWith(-123456789, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
  it('does not misreport an empty Git result as success', async () => {
    mocks.spawn.mockImplementation(() => childResult(''));
    const result = await testCommandNetwork(DEFAULT_NETWORK_PROXY, new AbortController().signal, {
      env: {},
    });
    expect(result.git.status).toBe('failed');
  });
});
