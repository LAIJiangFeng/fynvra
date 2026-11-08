import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { asRecord } from '@shared/guards';
import { isPluginMode, type PluginEntry, type PluginKind } from '@shared/types/plugins';
import { translate } from '../../i18n';
import { samePath } from '../gitRepository';
import { isRegistryId, toSlug, uniqueId } from '../providers/jsonRegistry';

const FILE_VERSION = 1;
const MAX_NAME_LENGTH = 200;

export type PluginToRegister = Omit<PluginEntry, 'id' | 'enabled' | 'installedAt'>;
export type PluginAddOutcome = { ok: true; plugin: PluginEntry } | { ok: false; error: string };

export interface PluginRegistry {
  /** 全部插件。文件损坏时 reject（不清空、不改名），由调用方报错。 */
  list(): Promise<PluginEntry[]>;
  get(id: string): Promise<PluginEntry | undefined>;
  /** 同一来源或同一路径（Windows 上不分大小写）已登记的记录 */
  findDuplicate(candidate: { source: string; path?: string }): Promise<PluginEntry | undefined>;
  /** 同一来源或路径已登记时返回错误；新登记的默认启用。 */
  add(plugin: PluginToRegister): Promise<PluginAddOutcome>;
  /** 只删登记；返回被删的记录，id 不存在时返回 undefined。 */
  remove(id: string): Promise<PluginEntry | undefined>;
  setEnabled(id: string, enabled: boolean): Promise<PluginEntry | undefined>;
  /** 只改本地插件的加载路径 / 模式 / 来源路径；id 不存在或不是本地插件时返回 undefined。 */
  updateLocal(
    id: string,
    patch: { path: string; mode: 'copy'; sourcePath: string }
  ): Promise<PluginEntry | undefined>;
}

/**
 * `userData/plugins.json`：`{ version: 1, plugins: PluginEntry[] }`。本地插件的 path 是副本（copy）或原路径（link），
 * 复制本身由调用方完成（见 pluginCopies.ts）。
 * 读写串行、原子替换；与 skills.json / mcp.json 不同，文件损坏时报错而不是改名后按空表继续，
 * 避免用户的插件登记被静默清空。
 */
export function createPluginRegistry(options: {
  filePath: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}): PluginRegistry {
  const { filePath, platform = process.platform, now = Date.now } = options;
  let cache: PluginEntry[] | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  const load = async (): Promise<PluginEntry[]> => {
    cache ??= await readPlugins(filePath);
    return cache;
  };
  const transact = <R>(fn: (entries: PluginEntry[]) => { next?: PluginEntry[]; result: R }) =>
    enqueue(async () => {
      const { next, result } = fn(structuredClone(await load()));
      if (next) {
        await writeJsonAtomic(filePath, { version: FILE_VERSION, plugins: next });
        cache = structuredClone(next);
      }
      return result;
    });
  const duplicateOf = (entries: readonly PluginEntry[], source: string, path?: string) =>
    entries.find(
      (entry) =>
        entry.source === source ||
        samePath(entry.source, source, platform) ||
        (path !== undefined && samePath(entry.path, path, platform))
    );

  return {
    list: () => enqueue(async () => structuredClone(await load())),
    get: (id) =>
      enqueue(async () => {
        const found = (await load()).find((entry) => entry.id === id);
        return found ? structuredClone(found) : undefined;
      }),
    findDuplicate: (candidate) =>
      enqueue(async () => {
        const found = duplicateOf(await load(), candidate.source, candidate.path);
        return found ? structuredClone(found) : undefined;
      }),
    add: (plugin) =>
      transact((entries): { next?: PluginEntry[]; result: PluginAddOutcome } => {
        const duplicate = duplicateOf(entries, plugin.source, plugin.path);
        if (duplicate) {
          return {
            result: {
              ok: false,
              error: translate('plugins.alreadyRegistered', { name: duplicate.name }),
            },
          };
        }
        const name = plugin.name.trim().slice(0, MAX_NAME_LENGTH) || 'plugin';
        const entry: PluginEntry = {
          id: uniqueId(
            toSlug(name, 'plugin'),
            entries.map((existing) => existing.id)
          ),
          name,
          source: plugin.source,
          kind: plugin.kind,
          path: plugin.path,
          enabled: true,
          installedAt: now(),
          ...(plugin.kind === 'local' && plugin.mode ? { mode: plugin.mode } : {}),
          ...(plugin.kind === 'local' && plugin.mode === 'copy' && plugin.sourcePath
            ? { sourcePath: plugin.sourcePath }
            : {}),
        };
        return { next: [...entries, entry], result: { ok: true, plugin: entry } };
      }),
    remove: (id) =>
      transact((entries) => {
        const removed = entries.find((entry) => entry.id === id);
        return removed
          ? { next: entries.filter((entry) => entry.id !== id), result: removed }
          : { result: undefined };
      }),
    setEnabled: (id, enabled) =>
      transact((entries) => {
        const index = entries.findIndex((entry) => entry.id === id);
        const current = entries[index];
        if (!current) return { result: undefined };
        const updated = { ...current, enabled };
        return { next: entries.with(index, updated), result: updated };
      }),
    updateLocal: (id, patch) =>
      transact((entries) => {
        const index = entries.findIndex((entry) => entry.id === id);
        const current = entries[index];
        if (current?.kind !== 'local') return { result: undefined };
        const updated: PluginEntry = { ...current, ...patch };
        return { next: entries.with(index, updated), result: updated };
      }),
  };
}

async function readPlugins(filePath: string): Promise<PluginEntry[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = asRecord(JSON.parse(text))?.plugins;
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw)) throw new Error(translate('plugins.corrupt', { path: filePath }));

  const entries: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = parseStoredPlugin(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (entries.length < raw.length) {
    console.warn(`[plugins] ${filePath}：跳过 ${raw.length - entries.length} 条无效或重复的记录`);
  }
  return entries;
}

const KINDS: readonly PluginKind[] = ['local', 'npm', 'git'];

export function parseStoredPlugin(raw: unknown): PluginEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, source, kind, path, enabled, installedAt, mode, sourcePath } = record;
  if (!isRegistryId(id) || typeof name !== 'string' || !name.trim()) return null;
  if (typeof source !== 'string' || !source.trim()) return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind as PluginKind)) return null;
  if (typeof path !== 'string' || !path.trim()) return null;
  return {
    id,
    name: name.trim(),
    source,
    kind: kind as PluginKind,
    path,
    enabled: typeof enabled === 'boolean' ? enabled : true,
    installedAt: typeof installedAt === 'number' && Number.isFinite(installedAt) ? installedAt : 0,
    // 旧的本地记录没有 mode：不补字段，读取时按 link 处理；copy 缺 sourcePath 也仍可加载副本
    ...(kind === 'local' && isPluginMode(mode) ? { mode } : {}),
    ...(kind === 'local' && mode === 'copy' && typeof sourcePath === 'string' && sourcePath.trim()
      ? { sourcePath }
      : {}),
  };
}

/** 先写同目录临时文件再 rename 覆盖，进程中途退出也不会留下半截文件。 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
