import type { MarketPluginView } from '@shared/types/pluginMarket';
import { describe, expect, it } from 'vitest';
import {
  filterMarketPlugins,
  MARKET_STALE_MS,
  marketAction,
  marketNeedsRefresh,
  marketViewOf,
} from './marketView';

const latest = {
  version: '1.2.0',
  permissions: [],
  changelog: '',
  publishedAt: '2026-01-01',
  size: 1,
  hasReadme: false,
};

function view(patch: Partial<MarketPluginView> = {}): MarketPluginView {
  return {
    id: 'fynvra.demo',
    name: 'Demo',
    description: 'A demo plugin',
    author: 'me',
    repository: 'https://example.com/repo',
    license: 'MIT',
    category: 'tools',
    tags: ['Search'],
    tier: 'reviewed',
    kind: 'pi',
    latest,
    updateAvailable: false,
    ...patch,
  };
}

describe('marketAction', () => {
  const installed = { pluginId: 'p1', version: '1.0.0', enabled: true };
  it('未安装：有兼容版本可装，没有则需要更新 Fynvra', () => {
    expect(marketAction(view())).toBe('install');
    expect(marketAction(view({ latest: undefined }))).toBe('incompatible');
  });
  it('已安装：有新版本显示更新，否则已安装', () => {
    expect(marketAction(view({ installed }))).toBe('installed');
    expect(marketAction(view({ installed, updateAvailable: true }))).toBe('update');
    expect(marketAction(view({ installed, latest: undefined }))).toBe('installed');
  });
});

describe('filterMarketPlugins', () => {
  const list = [
    view(),
    view({ id: 'a.b', name: 'Other', description: 'x', tags: [], category: 'dev' }),
  ];
  it('不区分大小写匹配名称、简介、标签', () => {
    expect(filterMarketPlugins(list, 'DEMO', 'all').map((p) => p.id)).toEqual(['fynvra.demo']);
    expect(filterMarketPlugins(list, 'search', 'all')).toHaveLength(1);
    expect(filterMarketPlugins(list, ' ', 'all')).toHaveLength(2);
  });
  it('按分类筛选', () => {
    expect(filterMarketPlugins(list, '', 'dev').map((p) => p.id)).toEqual(['a.b']);
    expect(filterMarketPlugins(list, 'demo', 'dev')).toHaveLength(0);
  });
});

describe('marketNeedsRefresh', () => {
  const now = 10 * MARKET_STALE_MS;
  it('未配置不刷新', () => {
    expect(marketNeedsRefresh({ configured: false, plugins: [] }, now)).toBe(false);
  });
  it('缓存为空或过期才刷新', () => {
    expect(marketNeedsRefresh({ configured: true, plugins: [], fetchedAt: now }, now)).toBe(true);
    expect(marketNeedsRefresh({ configured: true, plugins: [view()], fetchedAt: now }, now)).toBe(
      false
    );
    expect(
      marketNeedsRefresh(
        { configured: true, plugins: [view()], fetchedAt: now - MARKET_STALE_MS - 1 },
        now
      )
    ).toBe(true);
  });
  it('4 分钟内不刷新，6 分钟后刷新', () => {
    const minute = 60 * 1000;
    const at = (ago: number) => ({ configured: true, plugins: [view()], fetchedAt: now - ago });
    expect(marketNeedsRefresh(at(4 * minute), now)).toBe(false);
    expect(marketNeedsRefresh(at(6 * minute), now)).toBe(true);
  });
});

describe('marketViewOf', () => {
  it('按类别和已装 id 找市场视图，pi 与 fynvra 同 id 不串', () => {
    const installed = { pluginId: 'same', version: '1.0.0', enabled: true };
    const pi = view({ id: 'a.pi', installed });
    const app = view({ id: 'a.app', kind: 'fynvra', installed });
    const state = { configured: true, plugins: [pi, app] };
    expect(marketViewOf(state, 'same')).toBe(pi);
    expect(marketViewOf(state, 'same', 'fynvra')).toBe(app);
    expect(marketViewOf(state, 'other', 'fynvra')).toBeUndefined();
  });
});
