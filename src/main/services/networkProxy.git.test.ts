import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { commandEnvironment } from '@shared/networkProxy';
import { describe, expect, it } from 'vitest';
import { NETWORK_TEST_GIT_OPTIONS } from './networkTest';

const exec = promisify(execFile);

describe('Git consumes command proxy overrides without writing configuration', () => {
  it('diagnostic options override URL-specific TLS bypasses that a generic -c cannot override', async () => {
    const url = 'https://github.com/LAIJiangFeng/fynvra.git';
    const env = {
      ...process.env,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.sslVerify',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: `http.${url}.sslVerify`,
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: `http.${url}/.sslVerify`,
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_PARAMETERS: `'http.${url}.sslVerify=false' 'http.${url}/.sslVerify=false'`,
    };
    const get = async (options: readonly string[], target: string) =>
      (
        await exec('git', [...options, 'config', '--get-urlmatch', 'http.sslVerify', target], {
          cwd: tmpdir(),
          env,
          windowsHide: true,
          timeout: 5000,
        })
      ).stdout.trim();
    for (const target of [url, `${url}/`]) {
      expect(await get(['-c', 'http.sslVerify=true'], target)).toBe('false');
      expect(await get(NETWORK_TEST_GIT_OPTIONS, target)).toBe('true');
    }
  });
  it('preserves numbered entries and overrides inherited PARAMETERS with Git-compatible quoting', async () => {
    const env = commandEnvironment(
      {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'fynvra.test-preserved',
        GIT_CONFIG_VALUE_0: 'kept',
        GIT_CONFIG_PARAMETERS: "'http.proxy=old' 'fynvra.test-quoted=it'\\''s retained'",
      },
      { mode: 'manual', url: 'http://127.0.0.1:7890', gitCompatibility: true }
    );
    const get = async (key: string) =>
      (
        await exec('git', ['config', '--get', key], {
          cwd: tmpdir(),
          env,
          windowsHide: true,
          timeout: 5000,
        })
      ).stdout.trim();
    expect(await get('http.proxy')).toBe('http://127.0.0.1:7890');
    expect(await get('http.version')).toBe('HTTP/1.1');
    expect(await get('protocol.version')).toBe('0');
    expect(await get('fynvra.test-preserved')).toBe('kept');
    expect(await get('fynvra.test-quoted')).toBe("it's retained");
  });
});
