import { describe, expect, it, vi } from 'vitest';
import { extractMarked, loadLoginShellPath, mergePath, pickLoginShell } from './shellEnv';

const marked = (path: string) => `__FYNVRA_PATH_START__${path}__FYNVRA_PATH_END__`;

describe('extractMarked', () => {
  it('ignores noise around the markers', () => {
    expect(extractMarked(`motd\nplugin loaded\n${marked('/opt/bin:/usr/bin')}\nbye`)).toBe(
      '/opt/bin:/usr/bin'
    );
  });

  it('returns undefined without both markers', () => {
    expect(extractMarked('just noise')).toBeUndefined();
    expect(extractMarked('__FYNVRA_PATH_START__/usr/bin')).toBeUndefined();
  });
});

describe('mergePath', () => {
  it('puts login entries first, appends missing ones, dedupes and drops empties', () => {
    expect(mergePath('/opt/homebrew/bin::/usr/bin', '/usr/bin:/bin::/custom')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/custom'
    );
    expect(mergePath('/a', undefined)).toBe('/a');
  });
});

describe('pickLoginShell', () => {
  const exists = (path: string) => path === '/usr/local/bin/fish';

  it('uses SHELL when absolute and executable', () => {
    expect(pickLoginShell('darwin', { SHELL: '/usr/local/bin/fish' }, exists)).toBe(
      '/usr/local/bin/fish'
    );
  });

  it('falls back when SHELL is missing, relative or absent on disk', () => {
    expect(pickLoginShell('darwin', {}, exists)).toBe('/bin/zsh');
    expect(pickLoginShell('linux', { SHELL: 'fish' }, () => true)).toBe('/bin/bash');
    expect(pickLoginShell('linux', { SHELL: '/nope/sh' }, exists)).toBe('/bin/bash');
  });
});

describe('loadLoginShellPath', () => {
  const base = { isExecutable: () => true, warn: vi.fn() };

  it('does nothing on win32', async () => {
    const exec = vi.fn();
    const env = { PATH: 'C:\\bin' };
    await loadLoginShellPath({ ...base, platform: 'win32', env, exec });
    expect(exec).not.toHaveBeenCalled();
    expect(env.PATH).toBe('C:\\bin');
  });

  it('merges the login shell PATH', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
    const exec = vi.fn(async () => `noise${marked('/opt/homebrew/bin:/usr/bin')}`);
    await loadLoginShellPath({ ...base, platform: 'darwin', env, exec });
    expect(exec).toHaveBeenCalledWith('/bin/zsh', expect.arrayContaining(['-ilc']), env);
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it.each([
    ['spawn failure', () => Promise.reject(new Error('ENOENT'))],
    ['timeout', () => Promise.reject(Object.assign(new Error('timed out'), { killed: true }))],
    ['non-zero exit', () => Promise.reject(Object.assign(new Error('exit 1'), { code: 1 }))],
    ['missing markers', () => Promise.resolve('no markers')],
  ])('keeps PATH on %s', async (_name, exec) => {
    const warn = vi.fn();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    await loadLoginShellPath({ ...base, platform: 'linux', env, exec, warn });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(warn).toHaveBeenCalledOnce();
  });
});
