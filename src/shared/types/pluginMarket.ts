// 插件市场契约 v1（ARCHITECTURE §7.12「插件市场」）：索引解析、semver 比较、engines 判定与视图类型。
// 本文件不得 import Node / Electron。
import { asRecord } from '../guards';

export const MARKET_CATEGORIES = ['tools', 'integration', 'productivity', 'dev', 'other'] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export const MARKET_TIERS = ['official', 'reviewed'] as const;
export type MarketTier = (typeof MARKET_TIERS)[number];

export const MARKET_PERMISSIONS = ['network', 'filesystem', 'shell', 'env', 'model-keys'] as const;
export type MarketPermission = (typeof MARKET_PERMISSIONS)[number];

/** 包大小上限 50 MB；README 上限 256 KB */
export const MAX_MARKET_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_MARKET_README_BYTES = 256 * 1024;

export interface MarketFile {
  /** 相对基址的 POSIX 路径（已校验） */
  path: string;
  sha256: string;
  size: number;
}

export interface MarketVersion {
  version: string;
  /** `>=x.y.z`；没有时视为兼容 */
  engines?: { fynvra: string };
  /** 按 hostVersion 判定的 engines 兼容性（解析时算出） */
  compatible: boolean;
  commit: string;
  permissions: MarketPermission[];
  changelog: string;
  publishedAt: string;
  package: MarketFile;
  readme?: MarketFile;
}

export interface MarketPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  repository: string;
  license: string;
  category: MarketCategory;
  tags: string[];
  tier: MarketTier;
  /** 按版本号从新到旧排序 */
  versions: MarketVersion[];
}

export interface MarketRevocation {
  id: string;
  versions: string[] | 'all';
  reason: string;
}

export interface MarketIndex {
  schemaVersion: 1;
  sequence: number;
  generatedAt: string;
  plugins: MarketPlugin[];
  revoked: MarketRevocation[];
}

/** 市场里一个插件的视图（Renderer 用） */
export interface MarketPluginView {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  repository: string;
  license: string;
  category: MarketCategory;
  tags: string[];
  tier: MarketTier;
  /** 最新的兼容且未撤回的版本；没有可用版本时缺省 */
  latest?: {
    version: string;
    permissions: MarketPermission[];
    changelog: string;
    publishedAt: string;
    size: number;
    hasReadme: boolean;
  };
  /** 已安装时：plugins.json 里的 id、已装版本、是否启用 */
  installed?: { pluginId: string; version: string; enabled: boolean };
  /** 已安装且 latest 比已装版本新 */
  updateAvailable: boolean;
  /** 已安装的版本被撤回时才有 */
  revoked?: { reason: string };
}

export interface MarketStateView {
  /** 是否配置了公钥；false 时不发任何网络请求 */
  configured: boolean;
  /** 上次成功拉取索引的时间（epoch ms） */
  fetchedAt?: number;
  /** 上次刷新失败的原因（只带错误码） */
  error?: string;
  sequence?: number;
  plugins: MarketPluginView[];
}

const MARKET_ID = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const ENGINE_RANGE = /^>=(\d+\.\d+\.\d+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

export function isMarketPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && MARKET_ID.test(value);
}

export function isMarketVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && SEMVER.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/**
 * 比较两个 `x.y.z[-pre]` 版本：a < b 返回负数，相等 0，a > b 正数。预发布版本比同号正式版小；
 * 预发布段按 semver 规则逐段比较（纯数字段按数值且小于字母段）。非法版本号视为最小。
 */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const preA = pa[4];
  const preB = pb[4];
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  }
  const sa = preA.split('.');
  const sb = preB.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** engines.fynvra（`>=x.y.z`）是否接受 hostVersion；hostVersion 非法时一律不兼容 */
export function satisfiesEngine(range: string, hostVersion: string): boolean {
  const match = ENGINE_RANGE.exec(range);
  if (!match?.[1] || !SEMVER.test(hostVersion)) return false;
  return compareSemver(hostVersion, match[1]) >= 0;
}

/** 某插件的某版本是否被撤回；返回撤回原因，没有撤回时 null */
export function revocationOf(index: MarketIndex, id: string, version: string): string | null {
  for (const item of index.revoked) {
    if (item.id !== id) continue;
    if (item.versions === 'all' || item.versions.includes(version)) return item.reason;
  }
  return null;
}

/** 最新的兼容且未撤回的版本 */
export function latestUsableVersion(
  index: MarketIndex,
  plugin: MarketPlugin
): MarketVersion | undefined {
  return plugin.versions.find(
    (version) => version.compatible && revocationOf(index, plugin.id, version.version) === null
  );
}

/**
 * 解析并校验 index.json（契约 v1）。顶层不合法返回 null；单个插件、版本或撤回项不合法只丢弃那一项
 * （重复的 id / 版本保留第一个）。hostVersion 用来算每个版本的 engines 兼容性。
 */
export function parseMarketIndex(raw: unknown, hostVersion: string): MarketIndex | null {
  const record = asRecord(raw);
  if (record?.schemaVersion !== 1) return null;
  const { sequence, generatedAt, plugins, revoked } = record;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) return null;
  if (!isText(generatedAt, 1, 64)) return null;
  if (!Array.isArray(plugins) || !Array.isArray(revoked)) return null;
  const parsed: MarketPlugin[] = [];
  for (const item of plugins) {
    const plugin = parsePlugin(item, hostVersion);
    if (plugin && !parsed.some((existing) => existing.id === plugin.id)) parsed.push(plugin);
  }
  return {
    schemaVersion: 1,
    sequence,
    generatedAt,
    plugins: parsed,
    revoked: revoked.flatMap((item) => parseRevocation(item) ?? []),
  };
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isHttpsUrl(value: unknown): value is string {
  if (!isText(value, 9, 500) || !value.startsWith('https://')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 相对 POSIX 路径：只含 `[A-Za-z0-9._/-]`，不以 `/` 开头，不含 `..`，没有空段或 `.` 段 */
export function isSafeMarketPath(value: unknown): value is string {
  if (!isText(value, 1, 300) || !SAFE_PATH.test(value)) return false;
  if (value.startsWith('/') || value.includes('..')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.');
}

function parseFile(raw: unknown, maxSize: number): MarketFile | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { path, sha256, size } = record;
  if (!isSafeMarketPath(path) || !isSha256(sha256)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > maxSize) {
    return null;
  }
  return { path, sha256, size };
}

function parseVersion(raw: unknown, hostVersion: string): MarketVersion | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { version, engines, commit, permissions, changelog, publishedAt } = record;
  if (!isMarketVersion(version)) return null;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null;
  if (!Array.isArray(permissions) || !isText(changelog, 0, 2000)) return null;
  if (!isText(publishedAt, 1, 64)) return null;
  let range: string | undefined;
  if (engines !== undefined) {
    const fynvra = asRecord(engines)?.fynvra;
    if (typeof fynvra !== 'string' || !ENGINE_RANGE.test(fynvra)) return null;
    range = fynvra;
  }
  const pkg = parseFile(record.package, MAX_MARKET_PACKAGE_BYTES);
  if (!pkg) return null;
  const readme =
    record.readme === undefined ? undefined : parseFile(record.readme, MAX_MARKET_README_BYTES);
  if (readme === null) return null;
  return {
    version,
    ...(range ? { engines: { fynvra: range } } : {}),
    compatible: range ? satisfiesEngine(range, hostVersion) : true,
    commit,
    // 未知权限丢弃，去重
    permissions: MARKET_PERMISSIONS.filter((permission) => permissions.includes(permission)),
    changelog,
    publishedAt,
    package: pkg,
    ...(readme ? { readme } : {}),
  };
}

function parsePlugin(raw: unknown, hostVersion: string): MarketPlugin | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, description, author, homepage, repository, license, category, tags, tier } =
    record;
  if (!isMarketPluginId(id) || !isText(name, 1, 60) || !isText(description, 0, 1000)) return null;
  if (!isText(author, 1, 100) || !isText(license, 1, 40) || !isHttpsUrl(repository)) return null;
  if (homepage !== undefined && !isHttpsUrl(homepage)) return null;
  if (!MARKET_CATEGORIES.includes(category as MarketCategory)) return null;
  if (!MARKET_TIERS.includes(tier as MarketTier)) return null;
  if (!Array.isArray(tags) || tags.length > 10 || !tags.every((tag) => isText(tag, 1, 32))) {
    return null;
  }
  if (!Array.isArray(record.versions)) return null;
  const versions: MarketVersion[] = [];
  for (const item of record.versions) {
    const version = parseVersion(item, hostVersion);
    if (version && !versions.some((existing) => existing.version === version.version)) {
      versions.push(version);
    }
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => compareSemver(b.version, a.version));
  return {
    id,
    name,
    description,
    author,
    ...(homepage !== undefined ? { homepage } : {}),
    repository,
    license,
    category: category as MarketCategory,
    tags: tags as string[],
    tier: tier as MarketTier,
    versions,
  };
}

function parseRevocation(raw: unknown): MarketRevocation | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, versions, reason } = record;
  if (!isMarketPluginId(id) || !isText(reason, 0, 200)) return null;
  if (versions === 'all') return { id, versions, reason };
  if (!Array.isArray(versions) || !versions.every(isMarketVersion)) return null;
  return { id, versions: [...versions], reason };
}

/** `plugins:market-refresh` 入参：undefined、`{}` 或 `{ force: boolean }` */
export function parseMarketRefreshInput(raw: unknown): { force: boolean } | null {
  if (raw === undefined) return { force: false };
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'force')) return null;
  if (record.force !== undefined && typeof record.force !== 'boolean') return null;
  return { force: record.force === true };
}

/** `plugins:market-install` / `plugins:market-readme` 入参：`{ pluginId, version }`，拒绝多余键 */
export function parseMarketVersionInput(
  raw: unknown
): { pluginId: string; version: string } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'pluginId' && key !== 'version')) {
    return null;
  }
  const { pluginId, version } = record;
  return isMarketPluginId(pluginId) && isMarketVersion(version) ? { pluginId, version } : null;
}
