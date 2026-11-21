// 插件市场（ARCHITECTURE §7.12「插件市场」）：拉取并验签索引、防回滚、缓存；安装 / 更新 / 撤回；定时检查。
// 绝不执行插件包里的任何代码或脚本；日志只记错误码，不带路径。
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asRecord } from '@shared/guards';
import {
  compareSemver,
  latestUsableVersion,
  type MarketIndex,
  type MarketPlugin,
  type MarketPluginView,
  type MarketStateView,
  type MarketVersion,
  parseMarketIndex,
  revocationOf,
} from '@shared/types/pluginMarket';
import type { PluginEntry } from '@shared/types/plugins';
import { type UnzipFileInfo, unzipSync } from 'fflate';
import { translate } from '../../i18n';
import { toSlug, uniqueId, writeJsonAtomic } from '../providers/jsonRegistry';
import { MARKET_BASE_URL } from './marketConfig';
import { MarketHttpError, type MarketHttpGet } from './marketHttp';
import {
  copyDirOf,
  freeCopyDirName,
  isStrictlyInside,
  removeCopyDir,
  renameWithRetry,
  swapCopyDir,
} from './pluginCopies';
import type { PluginRegistry } from './pluginRegistry';

/** 解压后上限：200 MB、20000 个条目（同本地副本上限） */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 20_000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;
const REFRESH_THROTTLE_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_README_CACHE = 50;
const MANIFEST = 'fynvra-plugin.json';

export type MarketActionResult =
  | { ok: true; plugin: PluginEntry }
  | { ok: false; code: 'invalid' | 'failed'; error: string };
export type MarketReadmeResult = { ok: true; text: string } | { ok: false; error: string };

export interface PluginMarketDeps {
  http: MarketHttpGet;
  publicKeys: readonly string[];
  registry: PluginRegistry;
  /** 副本根目录（同 ipc/plugins.ts 的 pluginCopyRoot） */
  copyRoot: () => string;
  /** `userData/plugin-market.json` */
  cachePath: string;
  /** Fynvra 版本（app.getVersion()），用于 engines 判定 */
  hostVersion: string;
  /** 桌面通知（调用方负责遵守通知总开关与提示音） */
  notify: (title: string, body: string) => void;
  /** 登记变化后广播 plugins:changed */
  onChanged: () => void;
  /** 安装 / 更新后扫描模型服务名，返回最新条目 */
  afterInstall?: (plugin: PluginEntry) => Promise<PluginEntry>;
  baseUrl?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface PluginMarket {
  /** 缓存里的状态，不发网络请求 */
  state(): Promise<MarketStateView>;
  refresh(options?: { force?: boolean }): Promise<MarketStateView>;
  install(input: { pluginId: string; version: string }): Promise<MarketActionResult>;
  /** id 为 plugins.json 里的插件 id */
  update(input: { id: string }): Promise<MarketActionResult>;
  readme(input: { pluginId: string; version: string }): Promise<MarketReadmeResult>;
  /** 启动 60 秒后强制刷新一次，之后每 24 小时一次；未配置公钥时什么也不做 */
  start(): void;
  stop(): void;
}

interface MarketCache {
  version: 1;
  maxSequence: number;
  fetchedAt: number;
  indexText: string;
  signature: string;
}

/** 带错误码的失败（message 即错误码） */
class MarketError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof MarketError || error instanceof MarketHttpError) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 对原始字节验 Ed25519 签名（base64 一行，可带换行）；任意一把公钥通过即可 */
export function verifyIndexSignature(
  bytes: Uint8Array,
  signatureText: string,
  publicKeys: readonly string[]
): boolean {
  const text = signatureText.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  const signature = Buffer.from(text, 'base64');
  if (signature.length !== 64) return false;
  return publicKeys.some((pem) => {
    try {
      return verify(null, bytes, createPublicKey(pem), signature);
    } catch {
      return false;
    }
  });
}

/** 验签并解析；任何一步不过都返回 null */
function verifiedIndex(
  bytes: Uint8Array,
  signatureText: string,
  publicKeys: readonly string[],
  hostVersion: string
): MarketIndex | null {
  if (!verifyIndexSignature(bytes, signatureText, publicKeys)) return null;
  try {
    return parseMarketIndex(JSON.parse(Buffer.from(bytes).toString('utf8')), hostVersion);
  } catch {
    return null;
  }
}

function parseCache(text: string): MarketCache | null {
  try {
    const record = asRecord(JSON.parse(text));
    if (record?.version !== 1) return null;
    const { maxSequence, fetchedAt, indexText, signature } = record;
    if (typeof maxSequence !== 'number' || !Number.isSafeInteger(maxSequence) || maxSequence < 0) {
      return null;
    }
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
    if (typeof indexText !== 'string' || typeof signature !== 'string') return null;
    return { version: 1, maxSequence, fetchedAt, indexText, signature };
  } catch {
    return null;
  }
}

interface ZipEntry {
  segments: string[];
  /** null 表示目录条目 */
  data: Uint8Array | null;
}

/**
 * 在内存里解压并校验：先按条目头检查条目数与解压后总量，拒绝空名、绝对路径、`..` / `.` 段、反斜杠、
 * 盘符与 `:`、重名（Windows 下不分大小写）；解压后再按实际字节数核一遍总量。
 */
export function extractZip(bytes: Uint8Array, platform: NodeJS.Platform): ZipEntry[] {
  const seen = new Set<string>();
  let count = 0;
  let declared = 0;
  const check = (info: UnzipFileInfo) => {
    count += 1;
    if (count > MAX_ZIP_ENTRIES) throw new MarketError('too-many-entries');
    declared += info.originalSize;
    if (declared > MAX_UNZIPPED_BYTES) throw new MarketError('too-large');
    const segments = entrySegments(info.name);
    if (!segments) throw new MarketError('bad-entry-name');
    const joined = segments.join('/');
    const key = platform === 'win32' ? joined.toLowerCase() : joined;
    if (seen.has(key)) throw new MarketError('duplicate-entry');
    seen.add(key);
    return true;
  };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: check });
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw new MarketError('zip-invalid');
  }
  let total = 0;
  const entries: ZipEntry[] = [];
  for (const [name, data] of Object.entries(files)) {
    total += data.length;
    if (total > MAX_UNZIPPED_BYTES) throw new MarketError('too-large');
    const segments = entrySegments(name);
    if (!segments) throw new MarketError('bad-entry-name');
    entries.push({ segments, data: name.endsWith('/') ? null : data });
  }
  return entries;
}

/** 条目名 → 路径段；不合法时 null。目录条目以 `/` 结尾 */
function entrySegments(name: string): string[] | null {
  if (!name || name.startsWith('/') || /[\\:\0]/.test(name)) return null;
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    ? segments
    : null;
}

export function createPluginMarket(deps: PluginMarketDeps): PluginMarket {
  const {
    http,
    publicKeys,
    registry,
    copyRoot,
    cachePath,
    hostVersion,
    notify,
    onChanged,
    afterInstall = async (plugin) => plugin,
    baseUrl = MARKET_BASE_URL,
    now = Date.now,
    platform = process.platform,
  } = deps;
  const configured = publicKeys.length > 0;
  let index: MarketIndex | null = null;
  let maxSequence = 0;
  let fetchedAt: number | undefined;
  let lastError: string | undefined;
  let loading: Promise<void> | null = null;
  let refreshing: Promise<void> | null = null;
  const readmes = new Map<string, string>();
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const ensureLoaded = () => {
    loading ??= loadCache();
    return loading;
  };

  async function loadCache(): Promise<void> {
    if (!configured) return;
    let text: string;
    try {
      text = await readFile(cachePath, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn(`[plugins] market cache read failed: ${errorCode(error)}`);
      }
      return;
    }
    const cache = parseCache(text);
    if (!cache) {
      // 坏文件改名留底，按空数据继续
      await rename(cachePath, `${cachePath}.corrupt-${now()}`).catch(() => undefined);
      console.warn('[plugins] market cache corrupt, moved aside');
      return;
    }
    maxSequence = cache.maxSequence;
    const parsed = verifiedIndex(
      Buffer.from(cache.indexText, 'utf8'),
      cache.signature,
      publicKeys,
      hostVersion
    );
    // 缓存里的索引要重新验签；验不过的不用，但 maxSequence 保留以防回滚
    if (parsed && parsed.sequence >= maxSequence) {
      index = parsed;
      fetchedAt = cache.fetchedAt;
    }
  }

  async function doRefresh(): Promise<void> {
    try {
      const bytes = await http(`${baseUrl}index.json`, { maxBytes: MAX_INDEX_BYTES });
      const sigBytes = await http(`${baseUrl}index.json.sig`, { maxBytes: MAX_SIGNATURE_BYTES });
      let indexText: string;
      try {
        // fatal + 保留 BOM：存成文本再转回字节时与原始字节一致，缓存才能重新验签
        indexText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new MarketError('index-not-utf8');
      }
      const signature = Buffer.from(sigBytes).toString('latin1');
      if (!verifyIndexSignature(bytes, signature, publicKeys)) {
        throw new MarketError('bad-signature');
      }
      let parsed: MarketIndex | null;
      try {
        parsed = parseMarketIndex(JSON.parse(indexText), hostVersion);
      } catch {
        parsed = null;
      }
      if (!parsed) throw new MarketError('invalid-index');
      if (parsed.sequence < maxSequence) throw new MarketError('rollback');
      const at = now();
      const cache: MarketCache = {
        version: 1,
        maxSequence: parsed.sequence,
        fetchedAt: at,
        indexText,
        signature,
      };
      await writeJsonAtomic(cachePath, cache);
      index = parsed;
      maxSequence = parsed.sequence;
      fetchedAt = at;
      lastError = undefined;
    } catch (error) {
      const code = errorCode(error);
      console.warn(`[plugins] market refresh failed: ${code}`);
      lastError = translate('plugins.marketRefreshFailed', { error: code });
      return;
    }
    await checkRevocations().catch((error: unknown) => {
      console.warn(`[plugins] market revocation check failed: ${errorCode(error)}`);
    });
  }

  /** 已装版本被撤回且还没记原因的：停用、写原因、通知；撤回被取消的只清原因，不自动启用 */
  async function checkRevocations(): Promise<void> {
    if (!index) return;
    let changed = false;
    for (const entry of await registry.list()) {
      if (entry.kind !== 'market' || !entry.market) continue;
      const reason = revocationOf(index, entry.market.id, entry.market.version);
      if (reason !== null && entry.market.revokedReason === undefined) {
        await registry.updateMarket(entry.id, {
          market: { ...entry.market, revokedReason: reason },
          enabled: false,
        });
        notify(
          translate('plugins.marketRevokedTitle'),
          translate('plugins.marketRevokedBody', { name: entry.name, reason })
        );
        changed = true;
      } else if (reason === null && entry.market.revokedReason !== undefined) {
        const { revokedReason: _cleared, ...market } = entry.market;
        await registry.updateMarket(entry.id, { market });
        changed = true;
      }
    }
    if (changed) onChanged();
  }

  async function view(): Promise<MarketStateView> {
    await ensureLoaded();
    if (!configured) return { configured: false, plugins: [] };
    let entries: PluginEntry[] = [];
    if (index) {
      try {
        entries = await registry.list();
      } catch (error) {
        console.warn(`[plugins] market view: plugin list failed: ${errorCode(error)}`);
      }
    }
    const current = index;
    return {
      configured: true,
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
      ...(lastError ? { error: lastError } : {}),
      ...(current ? { sequence: current.sequence } : {}),
      plugins: current ? current.plugins.map((plugin) => toView(current, plugin, entries)) : [],
    };
  }

  function toView(
    current: MarketIndex,
    plugin: MarketPlugin,
    entries: readonly PluginEntry[]
  ): MarketPluginView {
    const latest = latestUsableVersion(current, plugin);
    const installed = entries.find((entry) => entry.market?.id === plugin.id);
    const installedVersion = installed?.market?.version;
    const reason =
      installedVersion === undefined ? null : revocationOf(current, plugin.id, installedVersion);
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      author: plugin.author,
      ...(plugin.homepage ? { homepage: plugin.homepage } : {}),
      repository: plugin.repository,
      license: plugin.license,
      category: plugin.category,
      tags: [...plugin.tags],
      tier: plugin.tier,
      ...(latest
        ? {
            latest: {
              version: latest.version,
              permissions: [...latest.permissions],
              changelog: latest.changelog,
              publishedAt: latest.publishedAt,
              size: latest.package.size,
              hasReadme: latest.readme !== undefined,
            },
          }
        : {}),
      ...(installed && installedVersion !== undefined
        ? {
            installed: {
              pluginId: installed.id,
              version: installedVersion,
              enabled: installed.enabled,
            },
          }
        : {}),
      updateAvailable:
        installedVersion !== undefined &&
        latest !== undefined &&
        compareSemver(latest.version, installedVersion) > 0,
      ...(reason !== null ? { revoked: { reason } } : {}),
    };
  }

  type Ready = { ok: true; index: MarketIndex } | { ok: false; code: 'invalid'; error: string };

  async function requireIndex(): Promise<Ready> {
    await ensureLoaded();
    if (!configured) {
      return { ok: false, code: 'invalid', error: translate('plugins.marketNotConfigured') };
    }
    if (!index)
      return { ok: false, code: 'invalid', error: translate('plugins.marketUnavailable') };
    return { ok: true, index };
  }

  function findVersion(current: MarketIndex, pluginId: string, version: string) {
    const plugin = current.plugins.find((item) => item.id === pluginId);
    const found = plugin?.versions.find((item) => item.version === version);
    return plugin && found ? { plugin, version: found } : null;
  }

  async function removeQuietly(root: string, dir: string): Promise<void> {
    await removeCopyDir(root, dir).catch((error: unknown) => {
      console.warn(`[plugins] market cleanup failed: ${errorCode(error)}`);
    });
  }

  /** 下载、校验、解压到 `<root>/.tmp-<uuid>`；失败不留临时目录 */
  async function stagePackage(
    root: string,
    pluginId: string,
    version: MarketVersion
  ): Promise<{ ok: true; tmp: string } | { ok: false; code: 'failed'; error: string }> {
    let bytes: Uint8Array;
    try {
      bytes = await http(`${baseUrl}${version.package.path}`, { maxBytes: version.package.size });
    } catch (error) {
      return {
        ok: false,
        code: 'failed',
        error: translate('plugins.marketDownloadFailed', { error: errorCode(error) }),
      };
    }
    const verifyFailed = (code: string) => ({
      ok: false as const,
      code: 'failed' as const,
      error: translate('plugins.marketVerifyFailed', { error: code }),
    });
    if (bytes.length !== version.package.size) return verifyFailed('size-mismatch');
    if (sha256Hex(bytes) !== version.package.sha256) return verifyFailed('sha256-mismatch');
    let entries: ZipEntry[];
    try {
      entries = extractZip(bytes, platform);
    } catch (error) {
      return verifyFailed(errorCode(error));
    }
    const manifest = entries.find(
      (entry) => entry.data && entry.segments.length === 1 && entry.segments[0] === MANIFEST
    );
    if (!manifest?.data) return verifyFailed('manifest-missing');
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(Buffer.from(manifest.data).toString('utf8')));
    } catch {
      record = null;
    }
    if (
      record?.schemaVersion !== 1 ||
      record.id !== pluginId ||
      record.version !== version.version
    ) {
      return verifyFailed('manifest-mismatch');
    }
    const tmp = join(root, `.tmp-${randomUUID()}`);
    try {
      await mkdir(tmp, { recursive: true });
      for (const entry of entries) {
        const target = join(tmp, ...entry.segments);
        // 再保险：目标必须严格在临时目录内
        if (!isStrictlyInside(tmp, target)) throw new MarketError('bad-entry-name');
        if (entry.data === null) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, entry.data);
        }
      }
    } catch (error) {
      await removeQuietly(root, tmp);
      return {
        ok: false,
        code: 'failed',
        error: translate('plugins.installFailed', { error: errorCode(error) }),
      };
    }
    return { ok: true, tmp };
  }

  async function install(input: {
    pluginId: string;
    version: string;
  }): Promise<MarketActionResult> {
    const ready = await requireIndex();
    if (!ready.ok) return ready;
    const found = findVersion(ready.index, input.pluginId, input.version);
    if (!found) return { ok: false, code: 'invalid', error: translate('plugins.marketNotFound') };
    const reason = revocationOf(ready.index, input.pluginId, input.version);
    if (reason !== null) {
      return { ok: false, code: 'invalid', error: translate('plugins.marketRevoked', { reason }) };
    }
    if (!found.version.compatible) {
      return {
        ok: false,
        code: 'invalid',
        error: translate('plugins.marketIncompatible', {
          range: found.version.engines?.fynvra ?? '',
        }),
      };
    }
    const existing = (await registry.list()).find((entry) => entry.market?.id === input.pluginId);
    if (existing) {
      return {
        ok: false,
        code: 'invalid',
        error: translate('plugins.marketAlreadyInstalled', { name: existing.name }),
      };
    }
    const root = copyRoot();
    await mkdir(root, { recursive: true });
    const staged = await stagePackage(root, input.pluginId, found.version);
    if (!staged.ok) return staged;
    let target: string;
    try {
      const ids = (await registry.list()).map((entry) => entry.id);
      const base = uniqueId(toSlug(found.plugin.name.trim() || 'plugin', 'plugin'), ids);
      target = join(root, await freeCopyDirName(root, base));
      await renameWithRetry(staged.tmp, target);
    } catch (error) {
      await removeQuietly(root, staged.tmp);
      return {
        ok: false,
        code: 'failed',
        error: translate('plugins.installFailed', { error: errorCode(error) }),
      };
    }
    let added: Awaited<ReturnType<PluginRegistry['add']>>;
    try {
      added = await registry.add({
        name: found.plugin.name,
        source: `market:${input.pluginId}@${input.version}`,
        kind: 'market',
        path: target,
        market: {
          id: input.pluginId,
          version: input.version,
          sha256: found.version.package.sha256,
          tier: found.plugin.tier,
        },
      });
    } catch (error) {
      added = { ok: false, error: translate('plugins.installFailed', { error: errorCode(error) }) };
    }
    if (!added.ok) {
      await removeQuietly(root, target);
      return { ok: false, code: 'failed', error: added.error };
    }
    const plugin = await afterInstall(added.plugin);
    onChanged();
    return { ok: true, plugin };
  }

  async function update(input: { id: string }): Promise<MarketActionResult> {
    const ready = await requireIndex();
    if (!ready.ok) return ready;
    const entry = await registry.get(input.id);
    if (!entry) return { ok: false, code: 'invalid', error: translate('plugins.notFound') };
    if (entry.kind !== 'market' || !entry.market) {
      return { ok: false, code: 'invalid', error: translate('plugins.marketNotMarket') };
    }
    const plugin = ready.index.plugins.find((item) => item.id === entry.market?.id);
    const latest = plugin && latestUsableVersion(ready.index, plugin);
    if (!plugin || !latest || compareSemver(latest.version, entry.market.version) <= 0) {
      return { ok: false, code: 'invalid', error: translate('plugins.marketNoUpdate') };
    }
    const root = copyRoot();
    const copyDir = copyDirOf(root, entry.path);
    if (!copyDir) {
      return { ok: false, code: 'invalid', error: translate('plugins.outsideCopyRoot') };
    }
    const staged = await stagePackage(root, plugin.id, latest);
    if (!staged.ok) return staged;
    const swapped = await swapCopyDir(root, copyDir, staged.tmp);
    if (!swapped.ok) return { ok: false, code: 'failed', error: swapped.error };
    // 新版本未撤回：清掉旧的撤回原因；启用状态与角色挂载不变
    const updated = await registry.updateMarket(entry.id, {
      source: `market:${plugin.id}@${latest.version}`,
      market: {
        id: plugin.id,
        version: latest.version,
        sha256: latest.package.sha256,
        tier: plugin.tier,
      },
    });
    if (!updated) return { ok: false, code: 'failed', error: translate('plugins.notFound') };
    const scanned = await afterInstall(updated);
    onChanged();
    return { ok: true, plugin: scanned };
  }

  async function readme(input: { pluginId: string; version: string }): Promise<MarketReadmeResult> {
    const ready = await requireIndex();
    if (!ready.ok) return ready;
    const found = findVersion(ready.index, input.pluginId, input.version);
    if (!found) return { ok: false, error: translate('plugins.marketNotFound') };
    const file = found.version.readme;
    if (!file) return { ok: false, error: translate('plugins.marketNoReadme') };
    const key = `${input.pluginId}@${input.version}:${file.sha256}`;
    const cached = readmes.get(key);
    if (cached !== undefined) return { ok: true, text: cached };
    let bytes: Uint8Array;
    try {
      bytes = await http(`${baseUrl}${file.path}`, { maxBytes: file.size });
    } catch (error) {
      return {
        ok: false,
        error: translate('plugins.marketDownloadFailed', { error: errorCode(error) }),
      };
    }
    if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
      return { ok: false, error: translate('plugins.marketVerifyFailed', { error: 'readme' }) };
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    if (readmes.size >= MAX_README_CACHE) readmes.clear();
    readmes.set(key, text);
    return { ok: true, text };
  }

  async function refresh(options?: { force?: boolean }): Promise<MarketStateView> {
    await ensureLoaded();
    if (!configured) return view();
    const fresh = fetchedAt !== undefined && now() - fetchedAt < REFRESH_THROTTLE_MS;
    if (options?.force || !fresh) {
      // 并发刷新共用一次请求
      refreshing ??= doRefresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    }
    return view();
  }

  return {
    state: view,
    refresh,
    install,
    update,
    readme,
    start() {
      if (!configured || firstTimer || intervalTimer) return;
      const run = () => {
        void refresh({ force: true }).catch((error: unknown) => {
          console.warn(`[plugins] market check failed: ${errorCode(error)}`);
        });
      };
      firstTimer = setTimeout(() => {
        firstTimer = null;
        run();
        intervalTimer = setInterval(run, CHECK_INTERVAL_MS);
        intervalTimer.unref?.();
      }, FIRST_CHECK_DELAY_MS);
      firstTimer.unref?.();
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      firstTimer = null;
      intervalTimer = null;
    },
  };
}
