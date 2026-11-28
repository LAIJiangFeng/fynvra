import { afterEach, describe, expect, it } from 'vitest';
import { collectKnownSecrets, registerSecretSource } from './known';
import {
  findLocalInfo,
  REDACTED_SECRET,
  redactSecrets,
  sanitizeLocalInfo,
  scanSecrets,
} from './scan';

// 测试用的假密钥按片段拼接，避免源码本身触发密钥扫描
const SAMPLES: [kind: string, value: string][] = [
  ['private-key', `-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`],
  ['sk-key', `sk-${'a1B2'.repeat(6)}`],
  ['github-token', `ghp_${'Ab3'.repeat(12)}`],
  ['github-pat', `github_pat_${'x9Y_'.repeat(6)}`],
  ['aws-access-key', `AKIA${'ABCD1234'.repeat(2)}`],
  ['telegram-bot-token', `123456789:${'Aa_-b'.repeat(7)}`],
  ['slack-token', `xoxb-${'123-abc'.repeat(3)}`],
];

describe('scanSecrets', () => {
  it.each(SAMPLES)('命中 %s，且结果里不含命中的值', (kind, value) => {
    const result = scanSecrets(`const config = "${value}";`, []);
    expect(result).toEqual({ hit: true, kinds: [kind] });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('已知密钥精确子串匹配', () => {
    const known = 'my-very-private-value';
    const result = scanSecrets(`token=${known}\n`, [known]);
    expect(result).toEqual({ hit: true, kinds: ['known-secret'] });
    expect(JSON.stringify(result)).not.toContain(known);
  });

  it('普通代码不误报', () => {
    const code = [
      'export function skip(task: Task) { return task.id; }',
      'const ask = "sk-short"; // AKIA is a prefix',
      'git push -u origin fynvra/fix-login',
      'const time = "12:30:45";',
    ].join('\n');
    expect(scanSecrets(code, ['unrelated-secret-value'])).toEqual({ hit: false, kinds: [] });
  });
});

describe('redactSecrets', () => {
  it.each(SAMPLES)('替换 %s，前后文保留', (_kind, value) => {
    const out = redactSecrets(`before ${value} after`, []);
    expect(out).toBe(`before ${REDACTED_SECRET} after`);
  });

  it('已知密钥全部替换，长的优先；空值忽略', () => {
    const known = ['abcdefgh', 'abcdefgh-longer', ''];
    expect(redactSecrets('x abcdefgh-longer y abcdefgh z abcdefgh', known)).toBe(
      `x ${REDACTED_SECRET} y ${REDACTED_SECRET} z ${REDACTED_SECRET}`
    );
  });

  it('普通文本原样返回', () => {
    expect(redactSecrets('用 pnpm test 跑测试，sk-short 不算', [])).toBe(
      '用 pnpm test 跑测试，sk-short 不算'
    );
  });
});

describe('findLocalInfo / sanitizeLocalInfo', () => {
  const ctx = {
    paths: ['C:\\Users\\Alice', 'D:\\work\\repo\\'],
    userName: 'alice',
    hostName: 'DESKTOP-42',
    windows: true,
  };

  it('Windows 路径不区分大小写，两种斜杠（含 JSON 转义）都算', () => {
    for (const text of [
      'see c:\\users\\alice\\AppData\\x.log',
      'see C:/Users/ALICE/projects',
      '{"cwd":"D:\\\\work\\\\repo\\\\src"}',
      'D:/WORK/repo',
    ]) {
      expect(findLocalInfo(text, { ...ctx, userName: undefined }), text).toEqual({
        hit: true,
        kinds: ['path'],
      });
    }
    expect(findLocalInfo('D:/work/repository', { ...ctx, userName: undefined }).hit).toBe(false);
  });

  it('替换路径、用户名、主机名', () => {
    expect(sanitizeLocalInfo('C:/users/alice/a.txt by Alice on desktop-42 (malice ok)', ctx)).toBe(
      '<本机路径>/a.txt by <用户名> on <主机名> (malice ok)'
    );
  });

  it('用户名按整词匹配，过短的不处理', () => {
    expect(findLocalInfo('the malice and alicent', ctx).hit).toBe(false);
    expect(findLocalInfo('by alice.', ctx).kinds).toEqual(['user-name']);
    const short = { paths: [], userName: 'al', hostName: 'pc' };
    expect(findLocalInfo('al pc', short).hit).toBe(false);
    expect(sanitizeLocalInfo('al pc', short)).toBe('al pc');
  });

  it('非 Windows 区分大小写', () => {
    const posix = { paths: ['/home/alice'], windows: false };
    expect(findLocalInfo('/home/alice/x', posix).hit).toBe(true);
    expect(findLocalInfo('/HOME/alice/x', posix).hit).toBe(false);
  });
});

describe('collectKnownSecrets', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it('收集服务 key、MCP env / headers、密钥类环境变量与注册来源，短值不收录', async () => {
    unregister = registerSecretSource('telegram', () => ['tg-token-0123456', 'short']);
    const values = await collectKnownSecrets({
      providers: { list: async () => [{ apiKey: ' provider-key-1 ' }, { apiKey: 'tiny' }, {}] },
      mcp: {
        list: async () => [
          {
            env: { API_TOKEN: 'mcp-env-value-1', DEBUG: '1' },
            headers: { Authorization: 'Bearer abcdefgh' },
          },
        ],
      },
      env: { GITHUB_TOKEN: 'env-token-value', PATH: '/usr/bin:/bin/long', DB_PASSWORD: 'pw' },
    });
    expect(values.sort()).toEqual(
      [
        'Bearer abcdefgh',
        'env-token-value',
        'mcp-env-value-1',
        'provider-key-1',
        'tg-token-0123456',
      ].sort()
    );
  });

  it('注销后注册来源不再生效', async () => {
    registerSecretSource('extra', () => ['registered-secret'])();
    expect(await collectKnownSecrets({})).toEqual([]);
  });
});
