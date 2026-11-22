import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { translate } from '../../i18n';
import { createAppPluginRegistry } from '../appPlugins/registry';
import { createAppPluginRuntime } from '../appPlugins/runtime';
import { createPluginSecretStore } from '../appPlugins/secrets';
import { createAppPluginService, readAppPluginManifest } from '../appPlugins/service';
import { createFakeFork } from '../appPlugins/testing';
import { createPluginMarket, type PluginMarketDeps, verifyIndexSignature } from './market';
import { MarketHttpError, type MarketHttpGet } from './marketHttp';
import { createPluginRegistry, type PluginRegistry } from './pluginRegistry';

const BASE = 'https://example.test/dist/';
const ID = 'fynvra.demo';

const keys = generateKeyPairSync('ed25519');
const PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');
const OTHER_PEM = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signText(bytes: Uint8Array): string {
  return `${sign(null, bytes, keys.privateKey).toString('base64')}\n`;
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

function pluginZip(version: string, extra: Record<string, string> = {}, manifestId = ID) {
  return zip({
    'fynvra-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: manifestId,
      name: 'Demo',
      version,
    }),
    'package.json': JSON.stringify({ name: 'demo', pi: { extensions: ['./index.js'] } }),
    'index.js': `export default () => {} // ${version}`,
    ...extra,
  });
}

let dir: string;
let files: Map<string, Uint8Array>;
let registry: PluginRegistry;
let notify: Mock<(title: string, body: string) => void>;
let onChanged: Mock<() => void>;
let http: Mock<MarketHttpGet>;
let clock: number;

interface VersionSpec {
  version: string;
  zip?: Uint8Array;
  engines?: string;
  /** 覆盖索引里的 size / sha256 */
  size?: number;
  sha256?: string;
  readme?: string;
}

/** 发布一份签过名的索引；revoked 同契约 */
function publish(
  versions: VersionSpec[],
  options: {
    sequence?: number;
    revoked?: unknown[];
    signWith?: (b: Uint8Array) => string;
    kind?: string;
    tier?: string;
    permissions?: string[];
  } = {}
) {
  const entries = versions.map((spec) => {
    const bytes = spec.zip ?? pluginZip(spec.version);
    const path = `packages/${ID}/${spec.version}.zip`;
    files.set(BASE + path, bytes);
    const entry: Record<string, unknown> = {
      version: spec.version,
      commit: 'c'.repeat(40),
      permissions: options.permissions ?? ['network'],
      changelog: 'notes',
      publishedAt: '2026-01-01T00:00:00Z',
      package: { path, sha256: spec.sha256 ?? sha(bytes), size: spec.size ?? bytes.length },
    };
    if (spec.engines) entry.engines = { fynvra: spec.engines };
    if (spec.readme !== undefined) {
      const readme = strToU8(spec.readme);
      const readmePath = `readme/${ID}/${spec.version}.md`;
      files.set(BASE + readmePath, readme);
      entry.readme = { path: readmePath, sha256: sha(readme), size: readme.length };
    }
    return entry;
  });
  const index = {
    schemaVersion: 1,
    sequence: options.sequence ?? 1,
    generatedAt: '2026-01-01T00:00:00Z',
    plugins: [
      {
        id: ID,
        name: 'Demo Plugin',
        description: 'demo',
        author: 'Fynvra',
        repository: 'https://github.com/x/demo',
        license: 'MIT',
        category: 'tools',
        tags: [],
        tier: options.tier ?? 'reviewed',
        ...(options.kind ? { kind: options.kind } : {}),
        versions: entries,
      },
    ],
    revoked: options.revoked ?? [],
  };
  const bytes = strToU8(JSON.stringify(index));
  files.set(`${BASE}index.json`, bytes);
  files.set(`${BASE}index.json.sig`, strToU8((options.signWith ?? signText)(bytes)));
}

function makeMarket(overrides: Partial<PluginMarketDeps> = {}) {
  return createPluginMarket({
    http,
    publicKeys: [PEM],
    registry,
    copyRoot: () => join(dir, 'plugins'),
    cachePath: join(dir, 'plugin-market.json'),
    hostVersion: '1.0.0',
    notify,
    onChanged,
    baseUrl: BASE,
    now: () => clock,
    ...overrides,
  });
}

async function copyRootEntries(): Promise<string[]> {
  return readdir(join(dir, 'plugins')).catch(() => []);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-market-'));
  files = new Map();
  clock = 1_000_000;
  registry = createPluginRegistry({ filePath: join(dir, 'plugins.json') });
  notify = vi.fn<(title: string, body: string) => void>();
  onChanged = vi.fn<() => void>();
  http = vi.fn<MarketHttpGet>(async (url, { maxBytes }) => {
    const bytes = files.get(url);
    if (!bytes) throw new MarketHttpError('http-404');
    if (bytes.length > maxBytes) throw new MarketHttpError('too-large');
    return bytes;
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('验签', () => {
  it('通过；篡改一个字节失败；多把公钥任意一把通过', () => {
    const bytes = strToU8('{"a":1}');
    const sig = signText(bytes);
    expect(verifyIndexSignature(bytes, sig, [PEM])).toBe(true);
    const tampered = Uint8Array.from(bytes);
    tampered[2] = (tampered[2] ?? 0) ^ 1;
    expect(verifyIndexSignature(tampered, sig, [PEM])).toBe(false);
    expect(verifyIndexSignature(bytes, sig, [OTHER_PEM])).toBe(false);
    expect(verifyIndexSignature(bytes, sig, ['not a key', OTHER_PEM, PEM])).toBe(true);
  });
});

describe('刷新与缓存', () => {
  it('公钥为空时 configured: false，且不发请求', async () => {
    const market = makeMarket({ publicKeys: [] });
    expect(await market.state()).toEqual({ configured: false, plugins: [] });
    expect(await market.refresh({ force: true })).toEqual({ configured: false, plugins: [] });
    expect(http).not.toHaveBeenCalled();
  });

  it('拉取、验签后返回视图，并能从缓存重新加载（重新验签）', async () => {
    publish([{ version: '1.0.0' }, { version: '1.1.0' }], { sequence: 5 });
    const state = await makeMarket().refresh();
    expect(state.sequence).toBe(5);
    expect(state.plugins[0]).toMatchObject({
      id: ID,
      tier: 'reviewed',
      latest: { version: '1.1.0', permissions: ['network'], hasReadme: false },
      updateAvailable: false,
    });
    const reloaded = makeMarket();
    http.mockClear();
    expect((await reloaded.state()).sequence).toBe(5);
    // 1 小时内非强制刷新直接用缓存
    await reloaded.refresh();
    expect(http).not.toHaveBeenCalled();
    // 换了公钥后缓存验不过，不用
    expect((await makeMarket({ publicKeys: [OTHER_PEM] }).state()).plugins).toEqual([]);
  });

  it('签名不符时报错并保留旧缓存', async () => {
    publish([{ version: '1.0.0' }], { sequence: 2 });
    const market = makeMarket();
    await market.refresh({ force: true });
    publish([{ version: '2.0.0' }], {
      sequence: 3,
      signWith: (b) => `${sign(null, b, other.privateKey).toString('base64')}\n`,
    });
    const state = await market.refresh({ force: true });
    expect(state.error).toContain('bad-signature');
    expect(state.sequence).toBe(2);
  });

  it('防回滚：sequence 变小被拒，缓存不变', async () => {
    publish([{ version: '1.0.0' }], { sequence: 7 });
    const market = makeMarket();
    await market.refresh({ force: true });
    const cacheBefore = await readFile(join(dir, 'plugin-market.json'), 'utf8');
    publish([{ version: '0.9.0' }], { sequence: 6 });
    const state = await market.refresh({ force: true });
    expect(state.error).toContain('rollback');
    expect(state.sequence).toBe(7);
    expect(state.plugins[0]?.latest?.version).toBe('1.0.0');
    expect(await readFile(join(dir, 'plugin-market.json'), 'utf8')).toBe(cacheBefore);
    // 重启后仍按缓存里的 maxSequence 拒绝
    expect((await makeMarket().refresh({ force: true })).error).toContain('rollback');
  });

  it('缓存损坏时改名留底并按空数据继续', async () => {
    await writeFile(join(dir, 'plugin-market.json'), '{broken');
    const state = await makeMarket().state();
    expect(state).toEqual({ configured: true, plugins: [] });
    expect(
      (await readdir(dir)).some((name) => name.startsWith('plugin-market.json.corrupt-'))
    ).toBe(true);
  });
});

describe('安装', () => {
  it('成功时登记为 market 插件并广播', async () => {
    publish([{ version: '1.0.0' }]);
    const market = makeMarket();
    await market.refresh();
    const result = await market.install({ pluginId: ID, version: '1.0.0' });
    expect(result.ok).toBe(true);
    if (!result.ok || !('plugin' in result)) throw new Error('expected a PI plugin');
    expect(result.plugin).toMatchObject({
      kind: 'market',
      name: 'Demo Plugin',
      source: `market:${ID}@1.0.0`,
      enabled: true,
      market: { id: ID, version: '1.0.0', tier: 'reviewed' },
    });
    expect(await readFile(join(result.plugin.path, 'index.js'), 'utf8')).toContain('1.0.0');
    expect(await copyRootEntries()).toEqual(['demo-plugin']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    const view = await market.state();
    expect(view.plugins[0]?.installed).toEqual({
      pluginId: result.plugin.id,
      version: '1.0.0',
      enabled: true,
    });
    // 重复安装失败
    const again = await market.install({ pluginId: ID, version: '1.0.0' });
    expect(again.ok).toBe(false);
    expect(await registry.list()).toHaveLength(1);
  });

  const failures: [string, string, () => VersionSpec[] | [VersionSpec[], unknown[]]][] = [
    ['sha256 不符', 'sha256-mismatch', () => [{ version: '1.0.0', sha256: 'f'.repeat(64) }]],
    ['实际大小超过索引里的 size', 'too-large', () => [{ version: '1.0.0', size: 10 }]],
    [
      'zip-slip',
      'bad-entry-name',
      () => [{ version: '1.0.0', zip: pluginZip('1.0.0', { '../evil.js': 'x' }) }],
    ],
    [
      '反斜杠条目',
      'bad-entry-name',
      () => [{ version: '1.0.0', zip: pluginZip('1.0.0', { 'a\\b.js': 'x' }) }],
    ],
    [
      '条目数超限',
      'too-many-entries',
      () => [
        {
          version: '1.0.0',
          zip: pluginZip(
            '1.0.0',
            Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`f/${i}`, '']))
          ),
        },
      ],
    ],
    [
      'manifest id 不符',
      'manifest-mismatch',
      () => [{ version: '1.0.0', zip: pluginZip('1.0.0', {}, 'fynvra.other') }],
    ],
    [
      'manifest version 不符',
      'manifest-mismatch',
      () => [{ version: '1.0.0', zip: pluginZip('1.0.1') }],
    ],
    ['engines 不兼容', '>=2.0.0', () => [{ version: '1.0.0', engines: '>=2.0.0' }]],
    [
      '版本已撤回',
      'bad',
      () => [[{ version: '1.0.0' }], [{ id: ID, versions: ['1.0.0'], reason: 'bad' }]],
    ],
  ];

  for (const [name, expected, spec] of failures) {
    // 构造 2 万条目的 zip 在全量并行负载下可能超过默认 5 秒
    it(`${name}：失败且不留目录和登记`, { timeout: 30_000 }, async () => {
      const value = spec();
      const [versions, revoked] = Array.isArray(value[0])
        ? (value as [VersionSpec[], unknown[]])
        : [value as VersionSpec[], []];
      publish(versions, { revoked });
      const market = makeMarket();
      await market.refresh();
      const result = await market.install({ pluginId: ID, version: '1.0.0' });
      expect(result.ok ? '' : result.error).toContain(expected);
      expect(await registry.list()).toEqual([]);
      expect(await copyRootEntries()).toEqual([]);
      expect(onChanged).not.toHaveBeenCalled();
    });
  }

  it('Windows 下大小写不同的重名条目被拒', async () => {
    publish([{ version: '1.0.0', zip: pluginZip('1.0.0', { 'A.js': '1', 'a.js': '2' }) }]);
    const market = makeMarket({ platform: 'win32' });
    await market.refresh();
    expect((await market.install({ pluginId: ID, version: '1.0.0' })).ok).toBe(false);
    expect(await copyRootEntries()).toEqual([]);
  });
});

describe('更新与撤回', () => {
  async function installed() {
    publish([{ version: '1.0.0' }], { sequence: 1 });
    const market = makeMarket();
    await market.refresh();
    const result = await market.install({ pluginId: ID, version: '1.0.0' });
    if (!result.ok) throw new Error(result.error);
    if (!('plugin' in result)) throw new Error('expected a PI plugin');
    await registry.setEnabled(result.plugin.id, false);
    onChanged.mockClear();
    return { market, plugin: result.plugin };
  }

  it('成功换入新版本，保留启用状态', async () => {
    const { market, plugin } = await installed();
    publish([{ version: '1.0.0' }, { version: '1.1.0' }], { sequence: 2 });
    const state = await market.refresh({ force: true });
    expect(state.plugins[0]?.updateAvailable).toBe(true);
    const result = await market.update({ id: plugin.id });
    expect(result.ok).toBe(true);
    const entry = await registry.get(plugin.id);
    expect(entry).toMatchObject({
      enabled: false,
      path: plugin.path,
      source: `market:${ID}@1.1.0`,
      market: { version: '1.1.0' },
    });
    expect(await readFile(join(plugin.path, 'index.js'), 'utf8')).toContain('1.1.0');
    expect(await copyRootEntries()).toEqual(['demo-plugin']);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('新包校验失败时旧版本不受影响', async () => {
    const { market, plugin } = await installed();
    publish([{ version: '1.0.0' }, { version: '1.1.0', sha256: 'e'.repeat(64) }], { sequence: 2 });
    await market.refresh({ force: true });
    const result = await market.update({ id: plugin.id });
    expect(result.ok).toBe(false);
    expect((await registry.get(plugin.id))?.market?.version).toBe('1.0.0');
    expect(await readFile(join(plugin.path, 'index.js'), 'utf8')).toContain('1.0.0');
    expect(await copyRootEntries()).toEqual(['demo-plugin']);
  });

  it('刷新后自动停用被撤回的版本、写入原因、发通知；撤回取消只清原因', async () => {
    const { market, plugin } = await installed();
    await registry.setEnabled(plugin.id, true);
    publish([{ version: '1.0.0' }], {
      sequence: 2,
      revoked: [{ id: ID, versions: 'all', reason: 'malware' }],
    });
    const state = await market.refresh({ force: true });
    let entry = await registry.get(plugin.id);
    expect(entry?.enabled).toBe(false);
    expect(entry?.market?.revokedReason).toBe('malware');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toContain('malware');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(state.plugins[0]?.revoked).toEqual({ reason: 'malware' });
    expect(state.plugins[0]?.latest).toBeUndefined();
    // 同一撤回不重复通知
    await market.refresh({ force: true });
    expect(notify).toHaveBeenCalledTimes(1);
    publish([{ version: '1.0.0' }], { sequence: 3 });
    await market.refresh({ force: true });
    entry = await registry.get(plugin.id);
    expect(entry?.market?.revokedReason).toBeUndefined();
    expect(entry?.enabled).toBe(false);
  });
});

describe('README', () => {
  it('校验 sha256 后返回文本并缓存', async () => {
    publish([{ version: '1.0.0', readme: '# 你好' }]);
    const market = makeMarket();
    await market.refresh();
    expect(await market.readme({ pluginId: ID, version: '1.0.0' })).toEqual({
      ok: true,
      text: '# 你好',
    });
    http.mockClear();
    await market.readme({ pluginId: ID, version: '1.0.0' });
    expect(http).not.toHaveBeenCalled();
  });
});

/** Fynvra 插件包：清单 kind fynvra + host.main */
function appZip(
  version: string,
  manifest: Record<string, unknown> = {},
  extra: Record<string, string> = { 'dist/host.js': `export function activate() {} // ${version}` }
) {
  return zip({
    'fynvra-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: ID,
      name: 'Demo',
      version,
      kind: 'fynvra',
      host: { main: 'dist/host.js' },
      ...manifest,
    }),
    ...extra,
  });
}

/** 真实的登记 / 服务 + 假进程 */
function appStack() {
  const dataRoot = join(dir, 'fynvra-plugin-data');
  const appRegistry = createAppPluginRegistry({ filePath: join(dir, 'fynvra-plugins.json') });
  const { fork, processes } = createFakeFork();
  const secrets = createPluginSecretStore({
    filePath: join(dir, 'fynvra-plugin-secrets.json'),
    register: () => () => undefined,
  });
  const runtime = createAppPluginRuntime({
    registry: appRegistry,
    fork,
    apiDeps: {
      log: () => undefined,
      secrets,
      notify: () => undefined,
      commandEnv: async () => ({}),
      listWorkspaces: () => [],
      uiStore: { get: () => null, set: () => undefined, clear: () => undefined },
      legacyTelegram: { path: '' },
    },
    dataRoot,
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    entryPathOf: (record, main) => join(record.path, main),
    readMain: async (record) => {
      const checked = await readAppPluginManifest(record.path);
      return checked.ok ? checked.manifest.host.main : null;
    },
    onChanged: () => undefined,
  });
  const service = createAppPluginService({
    registry: appRegistry,
    runtime,
    secrets,
    root: () => join(dir, 'fynvra-plugins'),
    dataRoot,
    onChanged: () => undefined,
  });
  return { appRegistry, processes, service, runtime };
}

describe('Fynvra 插件分流', () => {
  it('官方 Fynvra 插件装进 fynvra-plugins/、登记并立即启动；PI 登记不受影响', async () => {
    publish([{ version: '1.0.0', zip: appZip('1.0.0') }], {
      kind: 'fynvra',
      tier: 'official',
      permissions: ['notifications', 'network', 'shell'],
    });
    const app = appStack();
    const market = makeMarket({ appPlugins: app.service });
    await market.refresh();
    const result = await market.install({ pluginId: ID, version: '1.0.0' });
    if (!result.ok || !('appPlugin' in result)) throw new Error('expected a Fynvra plugin');
    expect(result.appPlugin).toMatchObject({
      id: ID,
      source: 'market',
      tier: 'official',
      enabled: true,
      // 按 fynvra 词表过滤
      permissions: ['notifications', 'network'],
    });
    expect(await readdir(join(dir, 'fynvra-plugins'))).toEqual([ID]);
    expect(await registry.list()).toEqual([]);
    expect(app.processes).toHaveLength(1);
    expect(app.processes[0]?.sent[0]).toMatchObject({
      type: 'init',
      pluginId: ID,
      entryPath: join(dir, 'fynvra-plugins', ID, 'dist/host.js'),
    });
    await vi.waitFor(() => expect(app.runtime.status(ID)).toBe('running'));
    const view = await market.state();
    expect(view.plugins[0]).toMatchObject({
      kind: 'fynvra',
      installed: { pluginId: ID, version: '1.0.0', enabled: true },
    });
  });

  it('已审核的第三方 Fynvra 插件可以安装和更新', async () => {
    const { app, market } = await installedApp('reviewed');
    expect(await app.appRegistry.get(ID)).toMatchObject({ tier: 'reviewed', enabled: true });
    publish(
      [
        { version: '1.0.0', zip: appZip('1.0.0') },
        { version: '1.1.0', zip: appZip('1.1.0') },
      ],
      { kind: 'fynvra', tier: 'reviewed', sequence: 2 }
    );
    await market.refresh({ force: true });
    const result = await market.updateApp({ id: ID });
    expect(result).toMatchObject({ ok: true, plugin: { version: '1.1.0', tier: 'reviewed' } });
  });

  it('没有 Fynvra 插件服务时拒绝且不下载', async () => {
    publish([{ version: '1.0.0', zip: appZip('1.0.0') }], { kind: 'fynvra', tier: 'official' });
    const market = makeMarket();
    await market.refresh();
    http.mockClear();
    const result = await market.install({ pluginId: ID, version: '1.0.0' });
    expect(result).toEqual({
      ok: false,
      code: 'invalid',
      error: translate('appPlugins.unavailable'),
    });
    expect(http).not.toHaveBeenCalled();
  });

  const badPackages: [string, string, Uint8Array, string][] = [
    ['清单 kind 不是 fynvra', 'manifest-kind', appZip('1.0.0', { kind: 'pi' }), 'fynvra'],
    ['清单缺 host.main', 'manifest-invalid', appZip('1.0.0', { host: {} }), 'fynvra'],
    [
      'host.main 越界',
      'manifest-invalid',
      appZip('1.0.0', { host: { main: '../x.js' } }),
      'fynvra',
    ],
    ['host.main 不是文件', 'host-main-missing', appZip('1.0.0', {}, { 'other.js': '' }), 'fynvra'],
    ['PI 索引里放了 Fynvra 清单', 'manifest-kind', appZip('1.0.0'), 'pi'],
  ];
  for (const [name, code, bytes, kind] of badPackages) {
    it(`${name}：拒绝且不留目录和登记`, async () => {
      publish([{ version: '1.0.0', zip: bytes }], { kind, tier: 'official' });
      const app = appStack();
      const market = makeMarket({ appPlugins: app.service });
      await market.refresh();
      const result = await market.install({ pluginId: ID, version: '1.0.0' });
      expect(result.ok ? '' : result.error).toContain(code);
      expect(await app.appRegistry.list()).toEqual([]);
      expect(await registry.list()).toEqual([]);
      expect(await readdir(join(dir, 'fynvra-plugins')).catch(() => [])).toEqual([]);
      expect(await copyRootEntries()).toEqual([]);
    });
  }

  async function installedApp(tier: 'official' | 'reviewed' = 'official') {
    publish([{ version: '1.0.0', zip: appZip('1.0.0') }], { kind: 'fynvra', tier });
    const app = appStack();
    const market = makeMarket({ appPlugins: app.service });
    await market.refresh();
    const result = await market.install({ pluginId: ID, version: '1.0.0' });
    if (!result.ok) throw new Error(result.error);
    await vi.waitFor(() => expect(app.runtime.status(ID)).toBe('running'));
    return { app, market };
  }

  it('更新：停进程、换目录、更新登记并重启', async () => {
    const { app, market } = await installedApp();
    publish(
      [
        { version: '1.0.0', zip: appZip('1.0.0') },
        { version: '1.1.0', zip: appZip('1.1.0') },
      ],
      { kind: 'fynvra', tier: 'official', sequence: 2 }
    );
    const state = await market.refresh({ force: true });
    expect(state.plugins[0]?.updateAvailable).toBe(true);
    const result = await market.updateApp({ id: ID });
    expect(result).toMatchObject({ ok: true, plugin: { version: '1.1.0' } });
    expect(app.processes[0]?.sent.at(-1)).toEqual({ type: 'deactivate' });
    expect(app.processes).toHaveLength(2);
    expect(await readFile(join(dir, 'fynvra-plugins', ID, 'dist', 'host.js'), 'utf8')).toContain(
      '1.1.0'
    );
    expect(await readdir(join(dir, 'fynvra-plugins'))).toEqual([ID]);
    expect((await app.appRegistry.get(ID))?.version).toBe('1.1.0');
  });

  it('撤回：停用、停进程、写原因、发通知', async () => {
    const { app, market } = await installedApp();
    publish([{ version: '1.0.0', zip: appZip('1.0.0') }], {
      kind: 'fynvra',
      tier: 'official',
      sequence: 2,
      revoked: [{ id: ID, versions: ['1.0.0'], reason: 'broken' }],
    });
    await market.refresh({ force: true });
    expect(await app.appRegistry.get(ID)).toMatchObject({
      enabled: false,
      revokedReason: 'broken',
    });
    expect(app.processes[0]?.sent.at(-1)).toEqual({ type: 'deactivate' });
    expect(app.runtime.status(ID)).toBe('stopped');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toContain('broken');
    await market.refresh({ force: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
