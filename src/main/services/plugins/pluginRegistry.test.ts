import { describe, expect, it } from 'vitest';
import { parseStoredPlugin } from './pluginRegistry';

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
