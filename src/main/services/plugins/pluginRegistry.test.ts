import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPluginRegistry, parseStoredPlugin } from './pluginRegistry';

const base = {
  id: 'demo',
  name: 'Demo',
  source: 'market:fynvra.demo@1.0.0',
  kind: 'market',
  path: '/root/demo',
  enabled: true,
  installedAt: 1,
};
const market = { id: 'fynvra.demo', version: '1.0.0', sha256: 'a'.repeat(64), tier: 'official' };

describe('parseStoredPlugin: market', () => {
  it('接受合法的 market 记录', () => {
    expect(parseStoredPlugin({ ...base, market: { ...market, revokedReason: 'bad' } })).toEqual({
      ...base,
      market: { ...market, revokedReason: 'bad' },
    });
  });

  it('kind 为 market 但缺 market 字段或字段不合法时丢弃', () => {
    expect(parseStoredPlugin(base)).toBeNull();
    expect(parseStoredPlugin({ ...base, market: { ...market, sha256: 'x' } })).toBeNull();
    expect(parseStoredPlugin({ ...base, market: { ...market, tier: 'community' } })).toBeNull();
  });

  it('非 market 记录忽略 market 字段', () => {
    expect(parseStoredPlugin({ ...base, kind: 'npm', market })?.market).toBeUndefined();
  });
});

describe('parseStoredPlugin: description', () => {
  const npm = { ...base, kind: 'npm' };
  it('trim 后 1–300 字才保留', () => {
    expect(parseStoredPlugin({ ...npm, description: '  懒人模式 ' })?.description).toBe('懒人模式');
    for (const description of ['  ', 'x'.repeat(301), 1]) {
      expect(parseStoredPlugin({ ...npm, description })).not.toHaveProperty('description');
    }
  });
});

describe('updateScan: description', () => {
  it('写入、变更和删除简介', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fynvra-plugin-registry-'));
    try {
      const registry = createPluginRegistry({ filePath: join(dir, 'plugins.json') });
      const added = await registry.add({
        name: 'Demo',
        source: 'npm:demo',
        kind: 'npm',
        path: '/p',
      });
      if (!added.ok) throw new Error(added.error);
      const { id } = added.plugin;
      const scan = { providers: [], stamp: 'ab' };
      expect(
        (await registry.updateScan(id, '/p', { ...scan, description: 'd1' }))?.description
      ).toBe('d1');
      expect(
        (await registry.updateScan(id, '/p', { ...scan, description: 'd2' }))?.description
      ).toBe('d2');
      expect(await registry.updateScan(id, '/p', scan)).not.toHaveProperty('description');
      const reloaded = createPluginRegistry({ filePath: join(dir, 'plugins.json') });
      expect(await reloaded.get(id)).not.toHaveProperty('description');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
