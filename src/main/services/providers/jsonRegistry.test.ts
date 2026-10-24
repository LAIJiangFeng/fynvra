import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRegistry, isRegistryId, toSlug, uniqueId } from './jsonRegistry';

interface Item {
  id: string;
  label: string;
}

const parseItem = (raw: unknown): Item | null => {
  const record = asRecord(raw);
  return record && typeof record.id === 'string' && typeof record.label === 'string'
    ? { id: record.id, label: record.label }
    : null;
};

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-registry-'));
  filePath = join(dir, 'items.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const open = (path = filePath) =>
  createJsonRegistry<Item>({ filePath: path, key: 'items', parseEntry: parseItem, now: () => 42 });

const readDisk = () => JSON.parse(readFileSync(filePath, 'utf8'));

describe('createJsonRegistry', () => {
  it('文件不存在时是空表，只读不建文件', async () => {
    expect(await open().list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('transact 原子写入 { version, <key> }，不留临时文件；没有 next 就不写', async () => {
    const registry = open();
    expect(await registry.transact(() => ({ result: 'noop' }))).toBe('noop');
    expect(readdirSync(dir)).toEqual([]);

    const result = await registry.transact((items) => ({
      next: [...items, { id: 'a', label: 'A' }],
      result: items.length,
    }));
    expect(result).toBe(0);
    expect(readDisk()).toEqual({ version: 1, items: [{ id: 'a', label: 'A' }] });
    expect(readdirSync(dir)).toEqual(['items.json']);
    expect(await open().list()).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('读盘时丢弃非法条目和重复 id（先到先得）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        items: [{ id: 'a', label: 'A' }, { id: 'b' }, 'junk', { id: 'a', label: 'again' }],
      })
    );
    expect(await open().list()).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('坏 JSON 改名留底后按空表继续，下次写入不覆盖留底文件', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(filePath, '{ not json');
    const registry = open();
    expect(await registry.list()).toEqual([]);
    expect(readFileSync(`${filePath}.corrupt-42`, 'utf8')).toBe('{ not json');
    expect(error).toHaveBeenCalled();

    await registry.transact(() => ({ next: [{ id: 'b', label: 'B' }], result: undefined }));
    expect(readDisk().items).toEqual([{ id: 'b', label: 'B' }]);
    expect(readFileSync(`${filePath}.corrupt-42`, 'utf8')).toBe('{ not json');
  });

  it('文件读不了（非 ENOENT）时 reject，不当成空表', async () => {
    mkdirSync(filePath);
    await expect(open().list()).rejects.toThrow();
  });

  it('并发 transact 串行执行，不丢更新', async () => {
    const registry = open();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        registry.transact((items) => ({
          next: [...items, { id: `i${index}`, label: String(index) }],
          result: undefined,
        }))
      )
    );
    expect((await registry.list()).map((item) => item.id).sort()).toHaveLength(10);
    expect(readDisk().items).toHaveLength(10);
  });

  it('写入失败时 reject，内存状态保持不变', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const registry = open(join(blocker, 'items.json'));
    await expect(
      registry.transact(() => ({ next: [{ id: 'a', label: 'A' }], result: undefined }))
    ).rejects.toThrow();
    expect(await registry.list()).toEqual([]);
  });

  it('返回副本：改动返回值不影响仓库', async () => {
    const registry = open();
    await registry.transact(() => ({ next: [{ id: 'a', label: 'A' }], result: undefined }));
    const [first] = await registry.list();
    if (first) first.label = 'mutated';
    expect(await registry.list()).toEqual([{ id: 'a', label: 'A' }]);
  });
});

describe('ids', () => {
  it('toSlug：小写、非字母数字折叠为 -、截到 64 位；规整为空时用 fallback', () => {
    expect(toSlug('Anthropic', 'x')).toBe('anthropic');
    expect(toSlug('  My Skill_v2! ', 'x')).toBe('my-skill-v2');
    expect(toSlug('全栈开发', 'role')).toBe('role');
    const long = toSlug(`${'a'.repeat(63)} b`, 'x');
    expect(long).toBe('a'.repeat(63));
    expect(isRegistryId(long)).toBe(true);
  });

  it('uniqueId：撞名加 -2、-3…，加后缀后仍是合法 id', () => {
    expect(uniqueId('anthropic', [])).toBe('anthropic');
    expect(uniqueId('anthropic', ['anthropic'])).toBe('anthropic-2');
    expect(uniqueId('anthropic', ['anthropic', 'anthropic-2'])).toBe('anthropic-3');
    const base = 'a'.repeat(64);
    const next = uniqueId(base, [base]);
    expect(next).toBe(`${'a'.repeat(62)}-2`);
    expect(isRegistryId(next)).toBe(true);
  });

  it('isRegistryId：只接受小写 slug', () => {
    for (const ok of ['a', 'anthropic', 'gpt-5', 'a1-b2']) expect(isRegistryId(ok)).toBe(true);
    for (const bad of ['', 'A', '-a', 'a-', 'a/b', 'a b', 'a'.repeat(65), 1, null]) {
      expect(isRegistryId(bad)).toBe(false);
    }
  });
});
