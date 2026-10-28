import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { commandEnvironment } from '@shared/networkProxy';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('Git consumes command proxy overrides without writing configuration', () => {
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
