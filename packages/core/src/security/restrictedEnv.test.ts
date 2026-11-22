import { describe, expect, it } from 'vitest';
import { pickRestrictedEnv, RESTRICTED_ENV_WHITELIST } from './restrictedEnv';

describe('pickRestrictedEnv', () => {
  it('变量名不区分大小写，结果用白名单里的写法', () => {
    expect(
      pickRestrictedEnv({ Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', temp: 'C:\\t' })
    ).toEqual({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' });
  });

  it('去掉密钥、代理、NODE_OPTIONS 等白名单外的变量', () => {
    const picked = pickRestrictedEnv({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'x',
      GITLAB_TOKEN: 'x',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'x',
      OPENAI_API_KEY: 'x',
      HTTPS_PROXY: 'http://u:p@proxy',
      https_proxy: 'http://u:p@proxy',
      NODE_OPTIONS: '--require evil.js',
      GIT_DIR: '/x',
      npm_config_registry: 'http://x',
      HOME: undefined,
    });
    expect(Object.keys(picked)).toEqual(['PATH']);
  });

  it('白名单不含代理、GIT_、npm_config_ 与密钥类变量', () => {
    expect(
      RESTRICTED_ENV_WHITELIST.filter((name) =>
        /proxy|^git_|^npm_config_|token|key|secret|node_options/i.test(name)
      )
    ).toEqual([]);
  });
});
