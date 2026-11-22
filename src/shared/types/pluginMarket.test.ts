import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isSafeMarketPath,
  latestUsableVersion,
  parseMarketIndex,
  parseMarketRefreshInput,
  parseMarketVersionInput,
  satisfiesEngine,
} from './pluginMarket';

const SHA = 'a'.repeat(64);

function version(v: string, extra: Record<string, unknown> = {}) {
  return {
    version: v,
    commit: 'b'.repeat(40),
    permissions: ['network'],
    changelog: '',
    publishedAt: '2026-01-01T00:00:00Z',
    package: { path: `packages/fynvra.demo/${v}.zip`, sha256: SHA, size: 10 },
    ...extra,
  };
}

function plugin(extra: Record<string, unknown> = {}) {
  return {
    id: 'fynvra.demo',
    name: 'Demo',
    description: 'demo plugin',
    author: 'Fynvra',
    repository: 'https://github.com/x/y',
    license: 'MIT',
    category: 'tools',
    tags: ['a'],
    tier: 'official',
    versions: [version('1.0.0')],
    ...extra,
  };
}

function index(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sequence: 3,
    generatedAt: '2026-01-01T00:00:00Z',
    plugins: [plugin()],
    revoked: [],
    ...extra,
  };
}

describe('parseMarketIndex', () => {
  it('解析合法索引，版本按新到旧排序并算出兼容性', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({
            homepage: 'https://example.com',
            versions: [
              version('1.0.0'),
              version('2.0.0', { engines: { fynvra: '>=9.0.0' } }),
              version('1.1.0-beta.1'),
            ],
            readme: undefined,
          }),
        ],
        revoked: [{ id: 'fynvra.demo', versions: 'all', reason: 'bad' }],
      }),
      '1.0.0'
    );
    expect(parsed?.sequence).toBe(3);
    const versions = parsed?.plugins[0]?.versions ?? [];
    expect(versions.map((v) => v.version)).toEqual(['2.0.0', '1.1.0-beta.1', '1.0.0']);
    expect(versions[0]?.compatible).toBe(false);
    expect(versions[2]?.compatible).toBe(true);
    expect(parsed?.revoked).toEqual([{ id: 'fynvra.demo', versions: 'all', reason: 'bad' }]);
  });

  it('坏插件 / 坏版本 / 坏撤回项只丢弃那一项', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin(),
          plugin({ id: 'Bad.Id' }),
          plugin({ id: 'fynvra.other', tier: 'community' }),
          plugin({ id: 'fynvra.third', versions: [version('1.0.0'), version('x')] }),
          plugin({ id: 'fynvra.http', repository: 'http://insecure' }),
          plugin({ id: 'fynvra.tags', tags: Array.from({ length: 11 }, () => 't') }),
        ],
        revoked: [{ id: 'fynvra.demo', versions: ['nope'], reason: 'x' }],
      }),
      '1.0.0'
    );
    expect(parsed?.plugins.map((p) => p.id)).toEqual(['fynvra.demo', 'fynvra.third']);
    expect(parsed?.plugins[1]?.versions).toHaveLength(1);
    expect(parsed?.revoked).toEqual([]);
  });

  it('com.fynvra.* 只留给官方：非官方条目只丢这一项', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({ id: 'com.fynvra.telegram', kind: 'fynvra' }),
          plugin({ id: 'com.fynvra.fake', kind: 'fynvra', tier: 'reviewed' }),
          plugin({ id: 'acme.bot', kind: 'fynvra', tier: 'reviewed' }),
        ],
      }),
      '1.0.0'
    );
    expect(parsed?.plugins.map((p) => [p.id, p.tier])).toEqual([
      ['com.fynvra.telegram', 'official'],
      ['acme.bot', 'reviewed'],
    ]);
  });

  it('顶层不合法返回 null', () => {
    expect(parseMarketIndex(null, '1.0.0')).toBeNull();
    expect(parseMarketIndex(index({ schemaVersion: 2 }), '1.0.0')).toBeNull();
    expect(parseMarketIndex(index({ sequence: 0 }), '1.0.0')).toBeNull();
    expect(parseMarketIndex(index({ sequence: 1.5 }), '1.0.0')).toBeNull();
    expect(parseMarketIndex(index({ plugins: {} }), '1.0.0')).toBeNull();
    expect(parseMarketIndex(index({ revoked: undefined }), '1.0.0')).toBeNull();
  });

  it('path 含 ..、绝对路径或非法字符的版本被拒', () => {
    for (const path of ['../x.zip', '/abs.zip', 'a/../b.zip', 'a\\b.zip', 'a b.zip', 'a//b.zip']) {
      const parsed = parseMarketIndex(
        index({
          plugins: [
            plugin({ versions: [version('1.0.0', { package: { path, sha256: SHA, size: 1 } })] }),
          ],
        }),
        '1.0.0'
      );
      expect(parsed?.plugins, path).toEqual([]);
    }
    expect(isSafeMarketPath('packages/fynvra.demo/1.0.0.zip')).toBe(true);
  });

  it('未知 permission 被丢弃', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({ versions: [version('1.0.0', { permissions: ['shell', 'root', 'env'] })] }),
        ],
      }),
      '1.0.0'
    );
    expect(parsed?.plugins[0]?.versions[0]?.permissions).toEqual(['shell', 'env']);
  });

  it('包超过 50 MB 的版本被拒', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({
            versions: [
              version('1.0.0', {
                package: { path: 'p.zip', sha256: SHA, size: 50 * 1024 * 1024 + 1 },
              }),
            ],
          }),
        ],
      }),
      '1.0.0'
    );
    expect(parsed?.plugins).toEqual([]);
  });

  it('latestUsableVersion 跳过不兼容和被撤回的版本', () => {
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({
            versions: [
              version('1.0.0'),
              version('1.1.0'),
              version('2.0.0', { engines: { fynvra: '>=3.0.0' } }),
            ],
          }),
        ],
        revoked: [{ id: 'fynvra.demo', versions: ['1.1.0'], reason: 'x' }],
      }),
      '1.0.0'
    );
    const p = parsed?.plugins[0];
    expect(parsed && p && latestUsableVersion(parsed, p)?.version).toBe('1.0.0');
  });
});

describe('semver', () => {
  it('预发布版本比正式版小，数字段按数值比较', () => {
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('engines 判定', () => {
    expect(satisfiesEngine('>=0.5.0', '0.5.0')).toBe(true);
    expect(satisfiesEngine('>=0.5.0', '0.4.9')).toBe(false);
    expect(satisfiesEngine('>=0.5.0', '0.5.0-beta.1')).toBe(false);
    expect(satisfiesEngine('^0.5.0', '0.5.0')).toBe(false);
  });
});

describe('IPC 入参收窄', () => {
  it('refresh 只接受 force 布尔值', () => {
    expect(parseMarketRefreshInput(undefined)).toEqual({ force: false });
    expect(parseMarketRefreshInput({ force: true })).toEqual({ force: true });
    expect(parseMarketRefreshInput({ force: 'yes' })).toBeNull();
    expect(parseMarketRefreshInput({ force: true, url: 'x' })).toBeNull();
  });

  it('install / readme 拒绝多余键和非法类型', () => {
    expect(parseMarketVersionInput({ pluginId: 'fynvra.demo', version: '1.0.0' })).toEqual({
      pluginId: 'fynvra.demo',
      version: '1.0.0',
    });
    expect(
      parseMarketVersionInput({ pluginId: 'fynvra.demo', version: '1.0.0', path: '/x' })
    ).toBeNull();
    expect(parseMarketVersionInput({ pluginId: 'fynvra.demo', version: 1 })).toBeNull();
    expect(parseMarketVersionInput({ pluginId: '../x', version: '1.0.0' })).toBeNull();
    expect(parseMarketVersionInput('fynvra.demo')).toBeNull();
  });
});

describe('插件类别 kind', () => {
  it('缺省为 pi；未知 kind 的插件条目作废；权限按类别词表过滤', () => {
    const perms = ['network', 'shell', 'notifications', 'ui', 'bogus'];
    const parsed = parseMarketIndex(
      index({
        plugins: [
          plugin({ versions: [version('1.0.0', { permissions: perms })] }),
          plugin({
            id: 'fynvra.app',
            kind: 'fynvra',
            versions: [version('1.0.0', { permissions: perms })],
          }),
          plugin({ id: 'fynvra.bad', kind: 'theme' }),
        ],
      }),
      '1.0.0'
    );
    expect(parsed?.plugins.map((item) => [item.id, item.kind])).toEqual([
      ['fynvra.demo', 'pi'],
      ['fynvra.app', 'fynvra'],
    ]);
    expect(parsed?.plugins[0]?.versions[0]?.permissions).toEqual(['network', 'shell']);
    expect(parsed?.plugins[1]?.versions[0]?.permissions).toEqual([
      'notifications',
      'network',
      'ui',
    ]);
  });
});
