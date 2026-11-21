import type {
  MarketCategory,
  MarketPluginView,
  MarketStateView,
  PluginKind,
} from '@shared/types/pluginMarket';

/** 市场卡片上的主按钮 */
export type MarketAction = 'install' | 'installed' | 'update' | 'incompatible';

export function marketAction(plugin: MarketPluginView): MarketAction {
  if (plugin.installed) return plugin.updateAvailable && plugin.latest ? 'update' : 'installed';
  return plugin.latest ? 'install' : 'incompatible';
}

/** 按名称、简介、标签搜索（不区分大小写），再按分类筛选 */
export function filterMarketPlugins(
  plugins: readonly MarketPluginView[],
  query: string,
  category: MarketCategory | 'all'
): MarketPluginView[] {
  const needle = query.trim().toLowerCase();
  return plugins.filter(
    (plugin) =>
      (category === 'all' || plugin.category === category) &&
      (!needle ||
        [plugin.name, plugin.description, ...plugin.tags].some((text) =>
          text.toLowerCase().includes(needle)
        ))
  );
}

export const MARKET_STALE_MS = 60 * 60 * 1000;

/** 首次进入市场时是否要再拉一次：已配置，且缓存为空或超过 1 小时 */
export function marketNeedsRefresh(state: MarketStateView, now: number): boolean {
  if (!state.configured) return false;
  return (
    state.plugins.length === 0 ||
    state.fetchedAt === undefined ||
    now - state.fetchedAt > MARKET_STALE_MS
  );
}

/** 已装插件 id（pi → plugins.json，fynvra → fynvra-plugins.json）→ 市场视图 */
export function marketViewOf(
  state: MarketStateView | null,
  pluginId: string,
  kind: PluginKind = 'pi'
): MarketPluginView | undefined {
  return state?.plugins.find(
    (plugin) => plugin.kind === kind && plugin.installed?.pluginId === pluginId
  );
}
