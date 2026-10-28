import { describe, expect, it } from 'vitest';
import { commandEnvironment, DEFAULT_NETWORK_PROXY, parseNetworkProxy } from './networkProxy';
import { parsePreferences, parsePreferencesPatch } from './types/settings';

const manual = { mode: 'manual' as const, url: 'http://127.0.0.1:7890', gitCompatibility: true };

describe('network proxy configuration', () => {
  it('accepts HTTP/HTTPS, normalizes roots, saves and clears through typed preferences', () => {
    expect(parseNetworkProxy(manual)).toEqual(manual);
    expect(parseNetworkProxy({ ...manual, url: 'https://proxy.example:443/' })?.mode).toBe(
      'manual'
    );
    expect(parseNetworkProxy({ ...manual, url: 'http://[::1]:7890' })).not.toBeNull();
    expect(parsePreferencesPatch({ networkProxy: manual })).toEqual({ networkProxy: manual });
    expect(parsePreferences({ networkProxy: manual }).networkProxy).toEqual(manual);
    expect(parsePreferencesPatch({ networkProxy: undefined })).toEqual({ networkProxy: undefined });
    expect(parsePreferences({}).networkProxy).toBeUndefined();
    expect(
      parsePreferences({ networkProxy: { ...manual, url: 'http://user:secret@proxy' } })
        .networkProxy
    ).toBeUndefined();
  });

  it.each([
    '',
    'socks5://localhost:7890',
    'ftp://proxy',
    'http://u:p@proxy',
    'http://u@proxy',
    'http://@proxy',
    'http://proxy:0',
    'http://proxy:65536',
    'http://proxy:',
    'http://proxy:abc',
    'http://proxy/path',
    'http://proxy/.',
    'http://proxy/?x=1',
    'http://proxy#',
    'http://proxy?',
    'http://proxy\n',
    'http://proxy\u007f',
    ' http://proxy',
    'http://proxy\\foo',
  ])('rejects unsafe or unsupported URL %j', (url) => {
    expect(parseNetworkProxy({ ...manual, url })).toBeNull();
    expect(parsePreferencesPatch({ networkProxy: { ...manual, url } })).toBeNull();
  });

  it.each([
    null,
    {},
    { mode: 'manual', url: manual.url },
    { ...manual, env: {} },
    { mode: 'environment', url: manual.url, gitCompatibility: false },
    { ...manual, gitCompatibility: 'true' },
  ])('rejects unknown fields and malformed configurations', (raw) => {
    expect(parseNetworkProxy(raw)).toBeNull();
  });
});

describe('command environments', () => {
  const base = {
    PATH: '/bin',
    HTTP_PROXY: 'inherited',
    https_proxy: 'other',
    ALL_PROXY: 'socks5://inherited',
    No_PrOxY: '*',
    NO_PROXY: 'github.com',
    PI_SESSION_ID: 'session',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'retained',
  };
  it('is pure and preserves every inherited value without an override', () => {
    expect(commandEnvironment(base)).toEqual(base);
    expect(commandEnvironment(base, DEFAULT_NETWORK_PROXY)).toEqual(base);
    expect(commandEnvironment(base)).not.toBe(base);
  });
  it('overrides all casing consistently and appends Git proxy/compatibility without changing TLS', () => {
    const before = { ...base };
    const env = commandEnvironment(base, manual);
    expect(base).toEqual(before);
    expect(env).toMatchObject({
      HTTP_PROXY: manual.url,
      http_proxy: manual.url,
      HTTPS_PROXY: manual.url,
      https_proxy: manual.url,
      NO_PROXY: '',
      no_proxy: '',
      PI_SESSION_ID: 'session',
      PATH: '/bin',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'retained',
      GIT_CONFIG_KEY_1: 'http.proxy',
      GIT_CONFIG_VALUE_1: manual.url,
      GIT_CONFIG_KEY_2: 'http.version',
      GIT_CONFIG_VALUE_2: 'HTTP/1.1',
      GIT_CONFIG_KEY_3: 'protocol.version',
      GIT_CONFIG_VALUE_3: '0',
    });
    expect(env).not.toHaveProperty('ALL_PROXY');
    expect(env).not.toHaveProperty('No_PrOxY');
    expect(Object.values(env)).not.toContain('http.sslVerify');
  });
  it('can enable compatibility without overriding proxies', () => {
    const env = commandEnvironment(base, { mode: 'environment', gitCompatibility: true });
    expect(env.HTTP_PROXY).toBe(base.HTTP_PROXY);
    expect(env.NO_PROXY).toBe('github.com');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.version');
  });
  it.each(['-1', 'secret', '1.5', '100000000000', '2'])(
    'fails closed on invalid inherited Git config without leaking contents: %s',
    (count) => {
      expect(() => commandEnvironment({ ...base, GIT_CONFIG_COUNT: count }, manual)).toThrow(
        /inherited Git command configuration/
      );
    }
  );
  it('preserves Windows Git environment keys without creating casing conflicts', () => {
    const env = commandEnvironment(
      { Git_Config_Count: '1', Git_Config_Key_0: 'user.name', Git_Config_Value_0: 'retained' },
      manual,
      true
    );
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'retained',
    });
    expect(env).not.toHaveProperty('Git_Config_Count');
    expect(() =>
      commandEnvironment({ GIT_CONFIG_COUNT: '0', Git_Config_Count: '1' }, manual, true)
    ).toThrow('Ambiguous inherited Git command configuration.');
  });
  it('preserves unused inherited slots when appending', () => {
    const env = commandEnvironment(
      { GIT_CONFIG_KEY_0: 'unused', GIT_CONFIG_VALUE_0: 'secret' },
      manual
    );
    expect(env.GIT_CONFIG_KEY_3).toBe('unused');
    expect(env.GIT_CONFIG_VALUE_3).toBe('secret');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
  });
});
