// Fynvra 插件登记 `userData/fynvra-plugins.json`（ARCHITECTURE §7.12「Fynvra 插件」）。
// 原子写；文件损坏时改名留底，按空登记继续；写入串行。
import { readFile, rename } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import type { AppPluginPermission, AppPluginSource } from '@shared/types/appPlugins';
import {
  filterPermissions,
  isMarketPluginId,
  isMarketVersion,
  isSha256,
  MARKET_TIERS,
  type MarketTier,
} from '@shared/types/pluginMarket';
import { writeJsonAtomic } from '../providers/jsonRegistry';

export interface AppPluginRecord {
  id: string;
  name: string;
  version: string;
  sha256?: string;
  /** 只有市场来源 */
  tier?: MarketTier;
  source: AppPluginSource;
  /** 包目录（fynvra-plugins/<dir>） */
  path: string;
  enabled: boolean;
  installedAt: string;
  permissions: AppPluginPermission[];
  revokedReason?: string;
  lastError?: string;
  /** 只有本地来源：复制来源目录 */
  sourcePath?: string;
}

export type AppPluginPatch = Partial<Omit<AppPluginRecord, 'id' | 'installedAt'>>;

export interface AppPluginRegistry {
  list(): Promise<AppPluginRecord[]>;
  get(id: string): Promise<AppPluginRecord | undefined>;
  add(record: Omit<AppPluginRecord, 'installedAt'>): Promise<AppPluginRecord>;
  /** 字段为 undefined 的键会被删除（用于清掉 revokedReason / lastError） */
  update(id: string, patch: AppPluginPatch): Promise<AppPluginRecord | undefined>;
  remove(id: string): Promise<boolean>;
}

function parseRecord(raw: unknown): AppPluginRecord | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, version, sha256, tier, source, path, enabled, installedAt, permissions } =
    record;
  if (!isMarketPluginId(id) || typeof name !== 'string' || !isMarketVersion(version)) return null;
  if (source !== 'market' && source !== 'local') return null;
  if (typeof path !== 'string' || path === '' || typeof enabled !== 'boolean') return null;
  if (typeof installedAt !== 'string') return null;
  if (sha256 !== undefined && !isSha256(sha256)) return null;
  if (tier !== undefined && !MARKET_TIERS.includes(tier as MarketTier)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const revokedReason = text(record.revokedReason);
  const lastError = text(record.lastError);
  const sourcePath = text(record.sourcePath);
  return {
    id,
    name,
    version,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(tier !== undefined ? { tier: tier as MarketTier } : {}),
    source,
    path,
    enabled,
    installedAt,
    permissions: filterPermissions(
      'fynvra',
      Array.isArray(permissions) ? permissions : []
    ) as AppPluginPermission[],
    ...(revokedReason !== undefined ? { revokedReason } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
}

export function createAppPluginRegistry(deps: {
  filePath: string;
  now?: () => number;
}): AppPluginRegistry {
  const { filePath, now = Date.now } = deps;
  let cache: AppPluginRecord[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<AppPluginRecord[]> {
    if (cache) return cache;
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      cache = [];
      return cache;
    }
    const record = (() => {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        return null;
      }
    })();
    if (record?.version !== 1 || !Array.isArray(record.plugins)) {
      // 坏文件改名留底，按空登记继续
      await rename(filePath, `${filePath}.corrupt-${now()}`).catch(() => undefined);
      console.warn('[appPlugins] fynvra-plugins.json corrupt, moved aside');
      cache = [];
      return cache;
    }
    const plugins: AppPluginRecord[] = [];
    for (const item of record.plugins) {
      const parsed = parseRecord(item);
      if (parsed && !plugins.some((existing) => existing.id === parsed.id)) plugins.push(parsed);
    }
    cache = plugins;
    return cache;
  }

  /** 写操作串行：读最新 → 改 → 原子写 → 换缓存 */
  function mutate<T>(
    change: (plugins: AppPluginRecord[]) => { next: AppPluginRecord[]; result: T }
  ) {
    const run = queue.then(async () => {
      const { next, result } = change(await load());
      await writeJsonAtomic(filePath, { version: 1, plugins: next });
      cache = next;
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async list() {
      await queue;
      return (await load()).map((plugin) => ({ ...plugin }));
    },
    async get(id) {
      await queue;
      const found = (await load()).find((plugin) => plugin.id === id);
      return found && { ...found };
    },
    add(input) {
      return mutate((plugins) => {
        if (plugins.some((plugin) => plugin.id === input.id)) {
          throw new Error(`duplicate plugin id: ${input.id}`);
        }
        const record: AppPluginRecord = { ...input, installedAt: new Date(now()).toISOString() };
        return { next: [...plugins, record], result: { ...record } };
      });
    },
    update(id, patch) {
      return mutate((plugins) => {
        const index = plugins.findIndex((plugin) => plugin.id === id);
        if (index < 0) return { next: plugins, result: undefined };
        const merged: Record<string, unknown> = { ...plugins[index], ...patch, id };
        for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
        const record = merged as unknown as AppPluginRecord;
        const next = [...plugins];
        next[index] = record;
        return { next, result: { ...record } };
      });
    },
    remove(id) {
      return mutate((plugins) => {
        const next = plugins.filter((plugin) => plugin.id !== id);
        return { next, result: next.length < plugins.length };
      });
    },
  };
}
