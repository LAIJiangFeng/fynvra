import type { MarketTier } from '@shared/types/pluginMarket';
import type { PluginKind } from '@shared/types/plugins';

export type PluginSourceIconKind =
  | 'official'
  | 'person'
  | 'local'
  | 'npm'
  | 'github'
  | 'gitlab'
  | 'git'
  | 'market';

/** 从 git 来源里取主机名（小写、去掉 www.）；解析不出返回 undefined */
export function gitHostOf(source: string): string | undefined {
  const rest = source
    .trim()
    .replace(/^git:(?!\/\/)/i, '')
    .replace(/^git\+/i, '');
  // 带协议：https://、http://、ssh://、git://，可带 user@ 和端口
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:?#]+)/i.exec(rest);
  // 无协议：git@host:o/r（scp 写法）或 host/o/r
  const bare = url ? undefined : /^(?:[^@/:]+@)?([^/:@\s]+)[:/]/.exec(rest);
  const host = (url ?? bare)?.[1]?.toLowerCase().replace(/^www\./, '');
  return host?.includes('.') ? host : undefined;
}

/**
 * 作者位图标：Fynvra 插件和市场卡片不传 kind（本地开发的 Fynvra 插件传 local），
 * PI 插件传 kind / source，市场分级都放在 tier
 */
export function pluginSourceIconKind({
  kind,
  source,
  tier,
}: {
  kind?: PluginKind;
  source?: string;
  tier?: MarketTier | null;
}): PluginSourceIconKind {
  if (kind === 'local' || kind === 'npm') return kind;
  if (kind === 'git') {
    const host = source ? gitHostOf(source) : undefined;
    return host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'git';
  }
  if (tier === 'official') return 'official';
  return kind === 'market' && !tier ? 'market' : 'person';
}
