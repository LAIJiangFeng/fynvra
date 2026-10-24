// providers.json / skills.json / mcp.json 共用的注册表文件读写，以及注册表 id 的生成规则。
// 放在 providers 目录是因为任务书只开放了 providers / roles / skills / mcp 这几个服务目录。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { asRecord } from '@shared/guards';

export const REGISTRY_FILE_VERSION = 1;

export interface JsonRegistryOptions<T> {
  filePath: string;
  /** 记录数组在文件里的字段名，如 `providers`。 */
  key: string;
  /** 宽松收窄一条磁盘记录；非法返回 null，该条被丢弃。 */
  parseEntry(raw: unknown): T | null;
  /** 坏文件改名留底用的时间戳，测试注入。 */
  now?: () => number;
}

export interface JsonRegistry<T> {
  /** 全部记录的副本。首次调用读盘：文件不存在为空表，文件读不了（非 ENOENT）时 reject。 */
  list(): Promise<T[]>;
  /**
   * 串行的读-改-写：`fn` 拿到当前记录的副本，返回 `next` 就原子写盘，写成功后才替换内存状态；
   * 不返回 `next` 表示不写。`fn` 抛错或写盘失败时 reject，状态不变。
   */
  transact<R>(fn: (entries: T[]) => { next?: T[]; result: R }): Promise<R>;
}

/** 一个 `{ version, <key>: T[] }` 形状的 JSON 文件：内存缓存 + 串行读改写 + 原子替换。 */
export function createJsonRegistry<T extends { id: string }>(
  options: JsonRegistryOptions<T>
): JsonRegistry<T> {
  const { filePath, key, parseEntry, now = Date.now } = options;
  let cache: T[] | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  // 所有读写排成一队；上一个失败不影响下一个
  const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<T[]> => {
    cache ??= await readEntries(filePath, key, parseEntry, now);
    return cache;
  };

  return {
    list: () => enqueue(async () => structuredClone(await load())),
    transact: (fn) =>
      enqueue(async () => {
        const { next, result } = fn(structuredClone(await load()));
        if (next) {
          await writeJsonAtomic(filePath, { version: REGISTRY_FILE_VERSION, [key]: next });
          cache = structuredClone(next);
        }
        return result;
      }),
  };
}

async function readEntries<T extends { id: string }>(
  filePath: string,
  key: string,
  parseEntry: (raw: unknown) => T | null,
  now: () => number
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  let raw: unknown;
  try {
    raw = asRecord(JSON.parse(text))?.[key];
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw)) {
    // 坏文件改名留底再按空表继续，下一次写入不会覆盖掉里面的 key
    const backup = `${filePath}.corrupt-${now()}`;
    await rename(filePath, backup);
    console.error(`[registry] ${filePath} 无法解析，已改名为 ${backup}`);
    return [];
  }

  const entries: T[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = parseEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (entries.length < raw.length) {
    console.warn(`[registry] ${filePath}：跳过 ${raw.length - entries.length} 条无效或重复的记录`);
  }
  return entries;
}

/** 先写同目录临时文件再 rename 覆盖，进程中途退出也不会留下半截文件。文件里可能有密钥，权限 0600。 */
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

const MAX_ID_LENGTH = 64;
const REGISTRY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * 注册表 id：小写字母、数字与 `-`，1–64 位，不以 `-` 开头或结尾（与角色 id 同一规则）。
 * id 由名称生成，角色文件里引用的是它，跨机器导入角色时同名服务 / 技能能对上。
 */
export function isRegistryId(value: unknown): value is string {
  return typeof value === 'string' && REGISTRY_ID.test(value);
}

/** 名称 → id 候选：小写，非字母数字的连续字符折叠为 `-`；规整后为空（如纯中文）时用 `fallback`。 */
export function toSlug(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** `base` 已被占用时依次尝试 `base-2`、`base-3`…，截断 `base` 保证结果仍不超过 64 位。 */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
