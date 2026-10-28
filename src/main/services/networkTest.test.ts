import { DEFAULT_NETWORK_PROXY, type NetworkProbeResult } from '@shared/networkProxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NetworkTestDeps, testCommandNetwork } from './networkTest';

afterEach(() => vi.useRealTimers());
const ok = async (): Promise<NetworkProbeResult> => ({ status: 'ok' });
const aborted = (_env: NodeJS.ProcessEnv, signal: AbortSignal) =>
  new Promise<NetworkProbeResult>((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'failed' }), { once: true });
  });

describe('network connection diagnostics', () => {
  it('reports independent outcomes and applies the same env strategy without leaking errors', async () => {
    const api = vi.fn<NetworkTestDeps['api']>(async () => ({
      status: 'ok' as const,
      httpStatus: 403,
    }));
    const git = vi.fn<NetworkTestDeps['git']>(async () => {
      throw new Error('https://user:SECRET@private; inherited key');
    });
    const result = await testCommandNetwork(
      { mode: 'manual', url: 'http://127.0.0.1:7890', gitCompatibility: true },
      new AbortController().signal,
      {
        api,
        git,
        env: {
          NO_PROXY: '*',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'SECRET',
        },
      }
    );
    expect(result).toEqual({ api: { status: 'ok', httpStatus: 403 }, git: { status: 'failed' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const env = api.mock.calls[0]?.[0] as unknown;
    expect(env).toEqual(git.mock.calls[0]?.[0]);
    expect(env).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '',
      GIT_CONFIG_COUNT: '4',
    });
  });
  it('keeps success in one probe when the other times out', async () => {
    vi.useFakeTimers();
    const result = testCommandNetwork(DEFAULT_NETWORK_PROXY, new AbortController().signal, {
      api: ok,
      git: aborted,
      env: {},
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toEqual({ api: { status: 'ok' }, git: { status: 'timeout' } });
  });
  it('supports cancel before start and while running', async () => {
    const controller = new AbortController();
    const api = vi.fn(aborted);
    const result = testCommandNetwork(DEFAULT_NETWORK_PROXY, controller.signal, {
      api,
      git: aborted,
      env: {},
    });
    controller.abort();
    expect(await result).toEqual({ api: { status: 'canceled' }, git: { status: 'canceled' } });
    api.mockClear();
    await testCommandNetwork(DEFAULT_NETWORK_PROXY, controller.signal, { api, git: ok });
    expect(api).not.toHaveBeenCalled();
  });
  it('invalid inherited configuration produces safe failure without starting probes', async () => {
    const api = vi.fn(ok);
    const result = await testCommandNetwork(
      { mode: 'environment', gitCompatibility: true },
      new AbortController().signal,
      {
        api,
        git: ok,
        env: { GIT_CONFIG_COUNT: 'SECRET' },
      }
    );
    expect(result).toEqual({ api: { status: 'failed' }, git: { status: 'failed' } });
    expect(api).not.toHaveBeenCalled();
  });
});
